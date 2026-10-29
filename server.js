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
const { createAuth, validUsersSaveData, USERS_FILE } = require('./lib/auth.cjs');
const { HOMEBREW_COLLECTIONS, sanitizeRulesHomebrew } = require('./lib/homebrew.cjs');
const {
  CONDITION_LABELS, normalizeAttacks, normalizeAbilities, normalizeRiders,
  normalizeResources, SPELL_FORMS, normalizeSummon, normalizeSpells, normalizeZones, normalizeSaveMods, normalizePending, normalizeConcentration,
  normalizeTurnState, riderApplies
} = require('./lib/combat-kit.cjs');
const { loadMonsterPacks } = require('./lib/monster-packs.cjs');
const { loadCharacterPacks, loadCharacterKit, LOOK_KEY_RE } = require('./lib/character-packs.cjs');

// Pure ES modules shared with the browser: the line-of-sight/light/senses
// model, the sky clock, the ground (heights + what crossing them costs),
// passage (which walls, doors and bars stop a walker) and aoe (which creatures
// a spell's area catches).
// Loaded before the server listens, so every handler can use them synchronously.
let vision = null, weatherModel = null, groundModel = null, passage = null, aoe = null;
const sharedModulesReady = Promise.all([
  import('./public/js/shared/vision.js'),
  import('./public/js/shared/weather.js'),
  import('./public/js/shared/ground.js'),
  import('./public/js/shared/passage.js'),
  import('./public/js/shared/aoe.js')
]).then(([visionModule, weatherModule, groundModule, passageModule, aoeModule]) => {
  vision = visionModule; weatherModel = weatherModule; groundModel = groundModule; passage = passageModule;
  aoe = aoeModule;
});

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
// Combat moves are priced against the terrain up to this length; anything
// longer is a relocation (GM), charged as the plain distance.
const MAX_PRICED_MOVE_FEET = 600;
// How far below a creature's stored position its soles sit (models.js
// halfHeight: 0.38 characters, 0.1 tokens).
const CHARACTER_SOLE_DEPTH = 0.38;
const TOKEN_SOLE_DEPTH = 0.1;
const MAP_KEY_LIMIT = 160;
const BUILD_LEVEL_MIN = -5;
const BUILD_LEVEL_MAX = 8;
const MAX_STRUCTURE_BATCH = 256;
const STRUCTURE_ID_LIMIT = 96;
const OBJECT_TYPES = new Set([
  'token', 'cube', 'sphere', 'character', 'cave', 'arch', 'portal', 'prop',
  'wall', 'floor', 'stair', 'roof'
]);
// Dungeon dressing (mirrors public/js/shared/props.js; tests/props.test.cjs).
const PROP_KINDS = ['torch', 'brazier', 'candles', 'shackles', 'bars', 'cot', 'table', 'bench', 'throne', 'lectern', 'bookshelf', 'crate', 'barrel', 'chest', 'egg', 'bones', 'rubble', 'stalagmite', 'pillar'];
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
// Optional look fields (mirrors public/js/shared/charmesh.js); absent on old
// sheets, which render with the race's defaults.
const CHARACTER_APPEARANCE_ENUMS = {
  body: new Set(['male', 'female']),
  outfit: new Set(['auto', 'tunic', 'robe', 'leather', 'mail', 'plate', 'bare']),
  hair: new Set(['short', 'long', 'tied', 'mohawk', 'bald']),
  beard: new Set(['none', 'short', 'long'])
};
const CHARACTER_TRAITS = ['pointed-ears', 'horns', 'tusks', 'snout', 'tail'];
// The parametric body: shape sliders, detail sliders and one worn asset per
// slot. Ids are only shape-checked here; the client ignores any its character
// kit (public/assets/characters/mh/kit.json) doesn't have.
const CHARACTER_FORM_KEYS = ['age', 'muscle', 'weight', 'stature'];
const CHARACTER_WEAR_SLOTS = ['bodyform', 'headform', 'hair', 'beard', 'eyebrows', 'horns', 'outfit', 'top', 'bottom', 'feet', 'hands', 'head'];
const CHARACTER_KIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_CHARACTER_DETAILS = 96;
const CHARACTER_COLOR_DEFAULTS = {
  skin: '#c68642', hair: '#3b2716', torso: '#2f6e56',
  legs: '#3a3f4a', eyes: '#1a1a1a'
};
const CHARACTER_ABILITY_METHODS = new Set(['point-buy', 'standard-array', 'manual']);
const MONSTER_SIZES = new Set(['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan']);
const MONSTER_ATTACK_TYPES = new Set(['melee', 'ranged']);
// Visual variants come from the committed monster model manifest (the same
// file the clients render from), so the server's accept-list can never drift
// from the assets. The ape pilot seeds itself if the manifest is missing.
const MONSTER_MANIFEST_PATH = path.join(__dirname, 'public', 'assets', 'monsters', 'manifest.json');
// Optional uncommitted model packs (lib/monster-packs.cjs) override entries of
// that manifest; clients fetch the merged result from the same URL.
const MONSTER_PACKS_DIR = path.resolve(process.env.THREEDX_PACKS_DIR || path.join(__dirname, 'data', 'packs'));
let mergedMonsterManifest = null; // JSON string, only when a pack contributes entries
const MONSTER_VARIANT_IDS = Object.create(null);   // index -> Set<variantId>
const MONSTER_VARIANT_DEFAULT = Object.create(null); // index -> first variant id
function registerMonsterVariants(index, rawVariants) {
  if (typeof index !== 'string' || !CHARACTER_REFERENCE_RE.test(index) || !Array.isArray(rawVariants)) return;
  const ids = rawVariants
    .map(variant => variant && typeof variant.id === 'string' && CHARACTER_REFERENCE_RE.test(variant.id) ? variant.id : null)
    .filter(Boolean);
  if (!ids.length) return;
  MONSTER_VARIANT_IDS[index] = new Set(ids);
  MONSTER_VARIANT_DEFAULT[index] = ids[0];
}
try {
  const manifest = JSON.parse(fs.readFileSync(MONSTER_MANIFEST_PATH, 'utf8'));
  const monsters = manifest && typeof manifest.monsters === 'object' && manifest.monsters ? manifest.monsters : null;
  if (!monsters) throw new Error('missing its monsters map');
  for (const [index, entry] of Object.entries(monsters)) {
    if (entry && typeof entry === 'object') registerMonsterVariants(index, entry.variants);
  }
  const packs = loadMonsterPacks(MONSTER_PACKS_DIR, monsters);
  packs.warnings.forEach(warning => console.warn(`[Monsters] Pack ${warning}`));
  packs.packs.forEach(pack => console.log(`[Monsters] Pack "${pack.name}": ${pack.count} model(s)`));
  if (Object.keys(packs.entries).length) {
    mergedMonsterManifest = JSON.stringify({ ...manifest, monsters: { ...monsters, ...packs.entries } });
  }
} catch (error) {
  console.error(`[Monsters] Could not load model manifest: ${error.message}`);
}
// Character "looks" from the same packs (lib/character-packs.cjs): whole
// models a player can pick in the creator. Always answered, empty without packs.
let characterLooksManifest = JSON.stringify({ version: 1, looks: {} });
{
  const packs = loadCharacterPacks(MONSTER_PACKS_DIR);
  packs.warnings.forEach(warning => console.warn(`[Characters] Pack ${warning}`));
  packs.packs.forEach(pack => console.log(`[Characters] Pack "${pack.name}": ${pack.count} look(s)`));
  characterLooksManifest = JSON.stringify({ version: 1, looks: packs.looks, props: packs.props });
}
let characterKitJSON;
{
  const { kit, dropped } = loadCharacterKit(path.join(__dirname, 'public', 'assets', 'characters', 'mh'));
  if (dropped.length) console.log(`[Characters] Private race parts not in this checkout: ${dropped.join(', ')}`);
  characterKitJSON = JSON.stringify(kit);
}
if (!MONSTER_VARIANT_IDS.ape) registerMonsterVariants('ape', [
  { id: 'silverback' }, { id: 'highland' }, { id: 'albino' }
]);
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

// Free text that keeps its line breaks (notes, backstory).
function boundedMultilineText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, maxLength);
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

// Visual variants are a server-owned rendering contract, not an asset path.
// Only monsters whose manifest entry declares variants get the field, and only
// declared IDs are accepted; anything else canonicalizes to the entry default.
function sanitizeMonsterVariant(monsterIndex, raw) {
  const index = typeof monsterIndex === 'string' ? monsterIndex.toLowerCase() : '';
  const allowed = ownValue(MONSTER_VARIANT_IDS, index);
  if (!allowed) return null;
  const requested = sanitizeReference(raw, 32);
  return allowed.has(requested) ? requested : MONSTER_VARIANT_DEFAULT[index];
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

// Every save file lives either in DATA_DIR (registry, homebrew and the
// default campaign's legacy files) or in a per-campaign subdirectory; `dir`
// selects the base so the same helpers serve both layouts.
function loadJSON(filename, defaultValue, validate = () => true, dir = activeStore ? activeStore.dir : DATA_DIR) {
  const filePath = path.join(dir, filename);
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
  return isRecord(value) && Object.values(HOMEBREW_COLLECTIONS).every(collection =>
    !hasOwn(value, collection) || isRecord(value[collection]));
}

function validatorForSave(filename) {
  if (filename === 'map_state.json') return validMapSaveData;
  if (filename === 'characters.json') return isRecord;
  if (filename === 'homebrew.json') return validHomebrewSaveData;
  if (filename === 'campaigns.json') return validCampaignsSaveData;
  if (filename === USERS_FILE) return validUsersSaveData;
  return () => true;
}

function saveJSON(filename, data, dir = activeStore ? activeStore.dir : DATA_DIR) {
  const filePath = path.join(dir, filename);
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

// Accounts + login sessions (data/saves/users.json, root-global like the
// campaign registry). THREEDX_OPEN_LOGIN=1 keeps the legacy password-less mode.
const auth = createAuth({
  dataDir: DATA_DIR, loadJSON, saveJSON,
  open: process.env.THREEDX_OPEN_LOGIN === '1'
});

// Compensation runs after a related file failed to commit. The current
// primary may contain the rejected half of that transaction, so rotating it
// would poison the last-known-good backup. Rewrite only the primary and leave
// the existing backup untouched for crash/corruption recovery.
function rewriteJSONPrimary(filename, data, dir = activeStore ? activeStore.dir : DATA_DIR) {
  const filePath = path.join(dir, filename);
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
function rewriteJSONBackup(filename, data, dir = activeStore ? activeStore.dir : DATA_DIR) {
  const backupPath = path.join(dir, filename) + '.bak';
  try {
    if (!validatorForSave(filename)(data)) throw new Error('data has an invalid shape');
    atomicWriteFile(backupPath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.error(`Error refreshing backup for ${filename}:`, e);
    return false;
  }
}

// ===== Campaign stores =====
// Each campaign owns a `maps` record and a character roster in its own save
// files. Node executes every socket handler to completion synchronously (all
// persistence below is sync), so binding the *active* store into these
// module-level handles around a handler is re-entrancy safe: withStore saves
// and restores the previous binding, and no other handler can interleave.
let activeStore = null;
let maps = {};
let charactersDB = {};
const stores = new Map();

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
  return saveJSON('map_state.json', { maps }, activeStore ? activeStore.dir : DATA_DIR);
}

function saveCharacters() {
  return saveJSON('characters.json', charactersDB, activeStore ? activeStore.dir : DATA_DIR);
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

// ===== Campaigns =====
// A campaign is one table: an owner (its GM), worldbuilding settings and its
// own isolated store (maps + roster + fog + combat). The registry lives in
// data/saves/campaigns.json; the default campaign keeps the legacy root files
// so existing installs and tests migrate with zero file moves.
const DEFAULT_CAMPAIGN_ID = 'default';
const MAX_CAMPAIGNS = 100;
const MAX_CAMPAIGN_NAME = 80;
const MAX_CAMPAIGN_DESCRIPTION = 400;
const MAX_CAMPAIGN_RECAP = 1200;
const MAX_CAMPAIGN_SESSIONS = 200;   // archived recaps kept per campaign
const BRIEF_SESSION_LIMIT = 20;      // newest N sent to clients (hall + GM panel)
const MAX_CAMPAIGN_MEMBERS = 64;
const MAX_PENDING_CAMPAIGNS_PER_USER = 3;
const BIOME_KEYS = ['plains', 'forest', 'mountains', 'desert', 'swamp', 'coast', 'tundra', 'taiga', 'snow'];
// Seasons are table state: they slide the snowline on every screen (worldgen.js SEASONS).
const SEASON_KEYS = ['summer', 'autumn', 'winter', 'spring'];
// Generator knob bounds; mirrors worldgen.js WORLD_LIMITS.
const WORLD_LIMITS = {
  ocean: [10, 90], landSize: [50, 300], wetness: [-100, 100], temperature: [-100, 100],
  latitude: [0, 100], rugged: [-100, 100], zones: [0, 100], relief: [0, 100]
};
// Sky clock + weather (table state, rendered client-side); mirrors shared/weather.js.
const WEATHER_KEYS = ['auto', 'clear', 'cloudy', 'overcast', 'rain', 'storm', 'snow', 'fog'];
const RAINBOW_KEYS = ['auto', 'on', 'off'];
const SKY_CLOCKS = ['fixed', 'cycle'];
const SKY_DAY_MINUTES = [2, 1440];
const CAMPAIGN_STYLES = new Set(['ladder', 'region']);

function validCampaignsSaveData(value) {
  return isRecord(value) &&
    (!hasOwn(value, 'campaigns') || isRecord(value.campaigns));
}

function defaultCampaignSettings() {
  const settings = {
    mapStyle: 'ladder',
    seed: 1337,
    biomes: [...BIOME_KEYS],
    spawn: { x: 0, z: 0 },
    // World shape (client generator knobs; mirrors worldgen.js WORLD_DEFAULTS —
    // these defaults reproduce the original world exactly).
    world: { ocean: 80, landSize: 100, wetness: 0, temperature: 0, latitude: 0, rugged: 0, zones: 0, relief: 0, home: null },
    season: 'summer',
    // hour = the game hour at `at` (epoch ms, stamped by the server whenever
    // the GM sets the clock); a cycling clock runs one day per dayMinutes.
    sky: { clock: 'fixed', hour: 10, dayMinutes: 24, at: 0, weather: 'auto', rainbow: 'auto' },
    // Token vision (shared/vision.js): off keeps the table as it always was.
    vision: { enabled: false, night: 'dim', indoors: 'auto', pockets: 'dim', memory: true },
    // Automatic movement costs in combat (shared/ground.js): slopes, water
    // and (optionally) snow are priced from the terrain itself.
    movement: { terrain: true, snow: true, walls: true },
    regionKey: null
  };
  return settings;
}

const VISION_NIGHT = ['dim', 'dark'];
const VISION_INDOORS = ['auto', 'bright', 'dim', 'dark'];
const VISION_POCKETS = ['bright', 'dim', 'dark'];
function sanitizeVisionSettings(raw, fallback) {
  const source = isRecord(raw) ? raw : {};
  const out = { ...fallback };
  if (typeof source.enabled === 'boolean') out.enabled = source.enabled;
  if (VISION_NIGHT.includes(source.night)) out.night = source.night;
  if (VISION_INDOORS.includes(source.indoors)) out.indoors = source.indoors;
  if (VISION_POCKETS.includes(source.pockets)) out.pockets = source.pockets;
  if (typeof source.memory === 'boolean') out.memory = source.memory;
  return out;
}

function sanitizeMovementSettings(raw, fallback) {
  const source = isRecord(raw) ? raw : {};
  const out = { ...fallback };
  if (typeof source.terrain === 'boolean') out.terrain = source.terrain;
  if (typeof source.snow === 'boolean') out.snow = source.snow;
  if (typeof source.walls === 'boolean') out.walls = source.walls;
  return out;
}

function sanitizeSky(raw, fallback) {
  const source = isRecord(raw) ? raw : {};
  const sky = { ...fallback };
  if (SKY_CLOCKS.includes(source.clock)) sky.clock = source.clock;
  const hour = Number(source.hour);
  if (source.hour != null && Number.isFinite(hour)) sky.hour = Math.round((((hour % 24) + 24) % 24) * 100) / 100;
  sky.dayMinutes = boundedInteger(source.dayMinutes, SKY_DAY_MINUTES[0], SKY_DAY_MINUTES[1], sky.dayMinutes);
  sky.at = boundedInteger(source.at, 0, 0x7fffffffffff, sky.at);
  if (WEATHER_KEYS.includes(source.weather)) sky.weather = source.weather;
  if (RAINBOW_KEYS.includes(source.rainbow)) sky.rainbow = source.rainbow;
  return sky;
}

// Axial hex (q,r) of the pointy-top hex containing (x,z) at a tier width.
// Cube-rounding mirrors shared/hexworld.js worldToHexAtTier — keep in sync.
function worldToHexAtTier(depth, x, z) {
  const R = TIER_WIDTH[depth] / SQRT3;
  const qf = (SQRT3 / 3 * x - 1 / 3 * z) / R;
  const rf = (2 / 3 * z) / R;
  let rq = Math.round(qf), ry = Math.round(-qf - rf), rr = Math.round(rf);
  const dq = Math.abs(rq - qf), dy = Math.abs(ry - (-qf - rf)), dr = Math.abs(rr - rf);
  if (dq > dy && dq > dr) rq = -ry - rr;
  else if (dy <= dr) rr = -rq - ry;
  return { q: rq, r: rr };
}

// Province lens (world/<kingdom>/<province>) whose hexes contain the spawn.
function regionKeyForSpawn(x, z) {
  const wx = Number(x) || 0, wz = Number(z) || 0;
  const kingdom = worldToHexAtTier(0, wx, wz);
  // Each tier's lattice is centered on its parent hex: resolve the province
  // from the point LOCAL to the kingdom hex center, not the world origin.
  const kc = hexCenterAtTier(0, kingdom.q, kingdom.r);
  const province = worldToHexAtTier(1, wx - kc.x, wz - kc.z);
  return `world/${kingdom.q},${kingdom.r}/${province.q},${province.r}`;
}

// Settings are server-derived: the region key always follows the spawn so a
// client can never widen the bounds of a single-region campaign.
function sanitizeCampaignSettings(raw) {
  const source = isRecord(raw) ? raw : {};
  const settings = defaultCampaignSettings();
  if (CAMPAIGN_STYLES.has(source.mapStyle)) settings.mapStyle = source.mapStyle;
  const seed = boundedInteger(source.seed, 0, 0x7fffffff, null);
  if (seed != null) settings.seed = seed;
  if (Array.isArray(source.biomes)) {
    const biomes = BIOME_KEYS.filter(key => source.biomes.includes(key));
    if (biomes.length) settings.biomes = biomes;
  }
  const spawn = sanitizeXZ(source.spawn);
  if (spawn) settings.spawn = spawn;
  if (isRecord(source.world)) {
    const w = source.world, world = { home: sanitizeXZ(w.home) };
    for (const key of Object.keys(WORLD_LIMITS)) {
      world[key] = boundedInteger(w[key], WORLD_LIMITS[key][0], WORLD_LIMITS[key][1], settings.world[key]);
    }
    settings.world = world;
  }
  if (SEASON_KEYS.includes(source.season)) settings.season = source.season;
  settings.sky = sanitizeSky(source.sky, settings.sky);
  settings.vision = sanitizeVisionSettings(source.vision, settings.vision);
  settings.movement = sanitizeMovementSettings(source.movement, settings.movement);
  if (settings.mapStyle === 'region') {
    settings.regionKey = regionKeyForSpawn(settings.spawn.x, settings.spawn.z);
  }
  return settings;
}

function sanitizeCampaignRecord(raw, id) {
  if (!isRecord(raw)) return null;
  const owner = boundedString(raw.owner, MAX_USERNAME_LENGTH) || 'gm';
  return {
    id,
    name: boundedText(raw.name, MAX_CAMPAIGN_NAME) || 'Untitled campaign',
    description: boundedText(raw.description, MAX_CAMPAIGN_DESCRIPTION),
    owner,
    createdAt: boundedInteger(raw.createdAt, 0, 0x7fffffffffff, 0),
    settings: sanitizeCampaignSettings(raw.settings),
    // Records from before accounts existed stay open to everyone.
    visibility: raw.visibility === 'private' ? 'private' : 'public',
    members: sanitizeCampaignMembers(raw.members),
    status: raw.status === 'pending' ? 'pending' : 'active',
    recap: boundedMultilineText(raw.recap, MAX_CAMPAIGN_RECAP),
    sessions: sanitizeCampaignSessions(raw.sessions),
    session: raw.session === 'closed' ? 'closed' : 'open'
  };
}

// What the campaign hall shows on entry: the premise (description), the GM's
// "last time" recap, the archived session history (newest first, bounded),
// and whether the table is open. Records created before the hall existed have
// neither field: no recap, table open.
function campaignBrief(campaign) {
  return {
    description: campaign.description || '',
    recap: campaign.recap || '',
    sessions: (campaign.sessions || []).slice(-BRIEF_SESSION_LIMIT).reverse()
      .map(s => ({ n: s.n, at: s.at, text: s.text })),
    session: campaign.session === 'closed' ? 'closed' : 'open'
  };
}

function sanitizeCampaignMembers(raw) {
  if (!Array.isArray(raw)) return [];
  const members = [];
  const seen = new Set();
  for (const candidate of raw.slice(0, MAX_CAMPAIGN_MEMBERS)) {
    const name = boundedString(candidate, MAX_USERNAME_LENGTH);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    members.push(name);
  }
  return members;
}

// Session history: each posted recap archives as { n, at, text }. `n` is the
// session number (1-based, never reused); `recap` on the record stays the
// newest text so the hall needs no extra lookup.
function sanitizeCampaignSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const sessions = [];
  for (const candidate of raw.slice(-MAX_CAMPAIGN_SESSIONS)) {
    if (!isRecord(candidate)) continue;
    const text = boundedMultilineText(candidate.text, MAX_CAMPAIGN_RECAP);
    if (!text) continue;
    sessions.push({
      n: boundedInteger(candidate.n, 1, 100000, sessions.length + 1),
      at: boundedInteger(candidate.at, 0, 0x7fffffffffff, 0),
      text
    });
  }
  return sessions;
}

function sameUser(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// Who may see a campaign in the lobby: the host everything, the owner their
// own (including one still awaiting approval), everyone else approved
// campaigns that are public or that they were invited to.
function canSeeCampaign(campaign, username) {
  if (!campaign || !username) return false;
  if (isGM(username) || sameUser(campaign.owner, username)) return true;
  if (campaign.status !== 'active') return false;
  return campaign.visibility === 'public' || campaign.members.some(member => sameUser(member, username));
}

// Entering needs an approved campaign; only the host may walk into a pending
// one (to look at what was requested).
function canEnterCampaign(campaign, username) {
  if (!canSeeCampaign(campaign, username)) return false;
  return campaign.status === 'active' || isGM(username);
}

let campaignsData = loadJSON('campaigns.json', { campaigns: {} }, validCampaignsSaveData);
const campaigns = {};
for (const [storedId, rawCampaign] of Object.entries(campaignsData.campaigns || {})) {
  const id = sanitizeReference(storedId, 40);
  const campaign = id && sanitizeCampaignRecord(rawCampaign, id);
  if (campaign) campaigns[id] = campaign;
}
campaignsData.campaigns = campaigns;

function campaignById(id) {
  return typeof id === 'string' && hasOwn(campaigns, id) ? campaigns[id] : null;
}

function saveCampaigns() {
  return saveJSON('campaigns.json', campaignsData);
}

// The default campaign is the migration target for legacy single-world saves
// and the implicit target of a plain (legacy) login.
function ensureDefaultCampaign() {
  if (campaignById(DEFAULT_CAMPAIGN_ID)) return false;
  campaigns[DEFAULT_CAMPAIGN_ID] = {
    id: DEFAULT_CAMPAIGN_ID,
    name: 'Default Campaign',
    description: '',
    owner: 'gm',
    createdAt: Date.now(),
    settings: defaultCampaignSettings(),
    visibility: 'public',
    members: [],
    status: 'active'
  };
  saveCampaigns();
  return true;
}
ensureDefaultCampaign();

// Save files: the default campaign keeps the legacy root paths; every other
// campaign gets its own subdirectory.
function campaignDir(id) {
  return id === DEFAULT_CAMPAIGN_ID ? DATA_DIR : path.join(DATA_DIR, 'campaigns', id);
}

function loadCampaignMaps(dir) {
  const data = loadJSON('map_state.json', { maps: {} }, validMapSaveData, dir);
  const loaded = data.maps;
  for (const map of Object.values(loaded)) {
    if (!map.objects) map.objects = {};
    if (!map.rulers) map.rulers = {};
  }
  return loaded;
}

function loadCampaignCharacters(dir) {
  const loaded = loadJSON('characters.json', {}, isRecord, dir);
  const db = {};
  for (const [storedId, rawCharacter] of Object.entries(loaded)) {
    const character = sanitizeCharacterPayload(rawCharacter);
    const id = sanitizeReference(rawCharacter && rawCharacter.id, 80) ||
      sanitizeReference(storedId, 80);
    if (!character || !id) continue;
    character.id = id;
    character.owner = boundedString(rawCharacter.owner, MAX_USERNAME_LENGTH) || 'gm';
    db[id] = character;
  }
  return db;
}

function withStore(store, fn) {
  const previous = activeStore;
  const previousMaps = maps;
  const previousCharacters = charactersDB;
  activeStore = store;
  maps = store.maps;
  charactersDB = store.characters;
  try {
    return fn();
  } finally {
    activeStore = previous;
    maps = previousMaps;
    charactersDB = previousCharacters;
  }
}

// Lazily load a campaign's store; the boot migrations run once per store on
// first touch (they are written against the bound `maps` handle).
function storeFor(campaignId) {
  const id = campaignId || DEFAULT_CAMPAIGN_ID;
  let store = stores.get(id);
  if (!store) {
    if (!campaignById(id)) return null;
    const dir = campaignDir(id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error(`Error creating campaign folder for ${id}:`, e); }
    store = { id, dir, maps: loadCampaignMaps(dir), characters: loadCampaignCharacters(dir) };
    stores.set(id, store);
    withStore(store, () => {
      migrateTacticalToWorld();
      migrateHexLayerRename();
      migrateUnifiedLensObjects();
      normalizePersistedCombatState();
    });
  }
  return store;
}

function activeCampaignId() {
  return activeStore ? activeStore.id : DEFAULT_CAMPAIGN_ID;
}

function activeCampaign() {
  return campaignById(activeCampaignId());
}

// Rooms are namespaced per campaign so two worlds can never cross-talk.
function campRoom(campaignId) { return 'camp:' + campaignId; }
function mapRoom(campaignId, key) { return 'camp:' + campaignId + ':' + key; }

function isCampaignGMFor(campaignId, username) {
  if (!username) return false;
  if (isGM(username)) return true;
  const campaign = campaignById(campaignId);
  // Case-insensitive like the global `gm` name: "Teste" still owns TESTE's table.
  return !!(campaign && String(campaign.owner).toLowerCase() === String(username).toLowerCase());
}

// Role inside the campaign the current handler is bound to. Homebrew content
// and login identity keep using the global isGM.
function isCampaignGM(username) {
  return isCampaignGMFor(activeCampaignId(), username);
}

function campaignSettings() {
  const campaign = activeCampaign();
  return (campaign && campaign.settings) || defaultCampaignSettings();
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
  if (username && obj && obj.type === 'summon') return obj.owner === username; // what your spell put there
  return !!(username && obj && obj.type === 'character' &&
    obj.characterData && obj.characterData.owner === username);
}
// ===== Token vision (shared/vision.js) =====
// With `settings.vision.enabled`, a player only RECEIVES the creatures their
// own character tokens can perceive: line of sight past walls, closed doors,
// floors and roofs, light at the target, and the viewer's senses. Map geometry
// is not withheld (the client darkens what is out of sight); creatures are.
// The server sends by the union of a player's tokens; the screen narrows that
// to the character being played.
function visionEnabled() {
  const settings = campaignSettings();
  return !!(settings.vision && settings.vision.enabled);
}
function visionContextFor(key) {
  const settings = campaignSettings();
  const sky = weatherModel.normalizeSky(settings.sky);
  return vision.visionContext(settings.vision, {
    hour: weatherModel.hourAt(sky),
    pocket: !isUnifiedKey(key),
    // Only a pinned weather is known here: natural weather is computed on
    // each screen from the local climate, which the server never loads.
    weather: weatherModel.WEATHER_PRESETS[sky.weather] || null
  });
}
// Occluders, lights and every owner's viewing tokens for one map. Memoized
// per map only until the next change (touchVision) or the end of the tick.
const visionMemo = new Map();
function touchVision() { visionMemo.clear(); }
function visionState(key) {
  const memoKey = activeCampaignId() + '|' + key;
  let state = visionMemo.get(memoKey);
  if (state) return state;
  const objects = Object.values((maps[key] && maps[key].objects) || {});
  const viewers = new Map();
  for (const obj of objects) {
    if (obj.type !== 'character' || !obj.characterData || !obj.position) continue;
    const owner = obj.characterData.owner;
    if (!viewers.has(owner)) viewers.set(owner, []);
    viewers.get(owner).push(vision.viewerOf(obj));
  }
  state = { occ: vision.buildOccluders(objects), ctx: visionContextFor(key), viewers };
  if (!visionMemo.size) setImmediate(touchVision);
  visionMemo.set(memoKey, state);
  return state;
}

// `key` is the state key the object lives on (the unified world by default).
function objectVisibleTo(username, obj, key = WORLD_KEY) {
  if (isCampaignGM(username)) return true;
  if (ownsObject(username, obj)) return true;
  if (obj.hidden === true) return false;        // GM-only until revealed
  const p = obj.position || {};
  if (isUnifiedKey(key) && !isRevealedAt(p.x, p.z)) return false;
  if (!vision.isCreature(obj) || !visionEnabled()) return true;
  const state = visionState(key);
  const viewers = state.viewers.get(username);
  return !!(viewers && vision.canAnySee(state.occ, state.ctx, viewers, vision.targetOf(obj)));
}

// Per-socket record of the creatures a player currently has, so a change in
// who-sees-whom becomes object-added / object-deleted for exactly that player.
function shownSet(sock) { return sock.visionShown || (sock.visionShown = new Set()); }
function forEachMapSocket(key, exceptSocket, fn) {
  if (isUnifiedKey(key)) emitToUnified(exceptSocket, fn);
  else emitToRoom(key, exceptSocket, fn);
}
// What stops a walker on one map (shared/passage.js), memoized with the sight
// state: both are rebuilt after any change to the map's objects.
function barriersFor(key) {
  const state = visionState(key);
  return state.barriers || (state.barriers = passage.buildBarriers(Object.values((maps[key] && maps[key].objects) || {})));
}
function wallsStopMoves() {
  return campaignSettings().movement?.walls !== false;
}
function walkerAt(obj, position = obj.position) {
  const soles = obj.type === 'character' ? CHARACTER_SOLE_DEPTH : TOKEN_SOLE_DEPTH;
  return { x: Number(position.x) || 0, z: Number(position.z) || 0, feet: (Number(position.y) || 0) - soles };
}

// Send one object to everyone on its map who may see it.
function announceObject(key, obj) {
  forEachMapSocket(key, null, (sock) => {
    if (!objectVisibleTo(sock.username, obj, key)) return;
    if (vision.isCreature(obj)) shownSet(sock).add(obj.id);
    sock.emit('object-added', projectObjectFor(sock.username, obj));
  });
}
// After anything that can change sight (a move, a door, a light, a wall, the
// hour, the rules): bring every player's creature set in line.
function reconcileVision(rawKey) {
  const key = stateKey(rawKey);
  const map = maps[key];
  if (!map) return;
  touchVision();
  const creatures = Object.values(map.objects).filter(vision.isCreature);
  forEachMapSocket(key, null, (sock) => {
    if (isCampaignGM(sock.username)) return;
    const shown = shownSet(sock);
    for (const obj of creatures) {
      if (ownsObject(sock.username, obj)) continue;
      const want = objectVisibleTo(sock.username, obj, key);
      const have = shown.has(obj.id);
      if (want && !have) {
        shown.add(obj.id);
        sock.emit('object-added', projectObjectFor(sock.username, obj));
      } else if (!want && have) {
        shown.delete(obj.id);
        sock.emit('object-deleted', { id: obj.id });
      }
    }
  });
}
function reconcileCampaignVision() {
  const campaignId = activeCampaignId();
  const keys = new Set();
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId === campaignId && sock.currentMapKey) keys.add(stateKey(sock.currentMapKey));
  }
  for (const key of keys) reconcileVision(key);
}
// Attack rolls against what you cannot see are at disadvantage; attacks from
// an attacker the target cannot see are at advantage (5e unseen attackers).
function sightModifiers(key, attacker, target) {
  const none = { advantage: false, disadvantage: false, note: '' };
  if (!visionEnabled()) return none;
  const objects = (maps[key] && maps[key].objects) || {};
  const a = ownValue(objects, attacker.id), b = ownValue(objects, target.id);
  if (!a || !b || !a.position || !b.position) return none;
  const state = visionState(key);
  const sees = (from, to) => {
    const how = vision.canSee(state.occ, state.ctx, vision.viewerOf(from), vision.targetOf(to));
    return !!how && how !== 'tremor';
  };
  const disadvantage = !sees(a, b), advantage = !sees(b, a);
  const notes = [];
  if (disadvantage) notes.push(`${attacker.name} can't see ${target.name}`);
  if (advantage) notes.push(`${target.name} can't see ${attacker.name}`);
  return { advantage, disadvantage, note: notes.length ? ` (${notes.join('; ')})` : '' };
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
  const sourceType = source.source === 'srd-5.1' ? 'srd-5.1' : 'homebrew';
  const projection = {
    name: boundedString(source.name, 80) || 'Creature',
    size: MONSTER_SIZES.has(source.size) ? source.size : 'Medium',
    type: boundedString(source.type, 40) || 'creature',
    color: sanitizeColor(source.color, '#b45309'),
    custom: source.custom === true,
    source: sourceType,
    public: true
  };
  const index = sanitizeReference(source.index, 96);
  // Players need a stable renderer key, but only expose an index proven to be
  // in the vendored SRD catalog. Homebrew rules remain private GM material.
  if (sourceType === 'srd-5.1' && index && ownValue(SRD_MONSTER_CATALOG, index)) {
    projection.index = index;
  }
  return projection;
}

function projectObjectFor(username, object) {
  if (!object || isCampaignGM(username)) return object;
  if (object.type === 'character' && isRecord(object.characterData)) {
    if (object.characterData.owner === username) return object;
    return { ...object, characterData: publicCharacterProjection(object.characterData) };
  }
  if (object.type === 'token' && isRecord(object.monsterData)) {
    const monsterData = publicMonsterProjection(object.monsterData);
    const projected = { ...object, monsterData };
    const variant = sanitizeMonsterVariant(monsterData.index, object.monsterVariant);
    if (variant) projected.monsterVariant = variant;
    else delete projected.monsterVariant;
    return projected;
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
  const room = io.sockets.adapter.rooms.get(mapRoom(activeCampaignId(), key));
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
// Scoped to the campaign the emitting handler is bound to.
function emitToUnified(exceptSocket, fn) {
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (exceptSocket && sock.id === exceptSocket.id) continue;
    if (!sock.username) continue;
    if (sock.campaignId !== campaignId) continue;
    if (!isUnifiedKey(sock.currentMapKey || '')) continue;
    fn(sock);
  }
}

// Detach a socket from a campaign's rooms (used by delete-campaign where the
// loop runs outside that socket's own connection scope).
function leaveCampaignRoomsFor(sock, campaignId) {
  if (sock.currentMapKey) sock.leave(mapRoom(campaignId, sock.currentMapKey));
  sock.leave(campRoom(campaignId));
}

// Own-character summaries for the lobby's "enter as player" picker. Only the
// requesting user's own sheets are listed, so this leaks nothing; the broadcast
// campaign-list omits rosters (fetch get-campaigns when a picker opens).
function ownedCharacterSummaries(campaignId, username) {
  const store = storeFor(campaignId);
  if (!store) return [];
  return withStore(store, () => Object.values(charactersDB)
    .filter(char => char.owner === username)
    .map(char => ({ id: char.id, name: char.name })));
}

// Lobby projection: every campaign with its online headcount. Broadcast to the
// lobby room only (a player may later get a "my campaigns" filter here).
function campaignsPayload(username) {
  const online = {};
  for (const sock of io.sockets.sockets.values()) {
    if (sock.username && sock.campaignId) {
      online[sock.campaignId] = (online[sock.campaignId] || 0) + 1;
    }
  }
  return Object.values(campaigns).filter(c => canSeeCampaign(c, username)).map(c => {
    const manages = isCampaignGMFor(c.id, username);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      owner: c.owner,
      createdAt: c.createdAt,
      settings: c.settings,
      visibility: c.visibility,
      status: c.status,
      invited: c.members.some(member => sameUser(member, username)),
      // The invite list is the GM's business, not the table's.
      members: manages ? c.members : undefined,
      online: online[c.id] || 0,
      myCharacters: ownedCharacterSummaries(c.id, username)
    };
  });
}

// Campaign lists are per user (privacy + invites), so the lobby is pushed
// socket by socket rather than as one room broadcast.
function pushCampaignList() {
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || !sock.rooms.has('lobby')) continue;
    sock.emit('campaign-list', { campaigns: campaignsPayload(sock.username) });
  }
}

// Account directory. The host gets the admin view; everyone else only the
// names they could invite.
function usersPayload(username) {
  const online = new Set();
  for (const sock of io.sockets.sockets.values()) {
    if (sock.username) online.add(sock.username.toLowerCase());
  }
  const host = isGM(username);
  return auth.list().filter(user => host || !user.disabled).map(user => host
    ? { ...user, online: online.has(user.username.toLowerCase()) }
    : { username: user.username });
}

function pushUserList() {
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || !sock.rooms.has('lobby')) continue;
    sock.emit('user-list', { users: usersPayload(sock.username) });
  }
}

// Remove a campaign, its files and everyone seated in it. -> false when the
// registry could not be saved (nothing changed).
function destroyCampaign(id) {
  const campaign = campaignById(id);
  if (!campaign) return false;
  const previousRecord = snapshotField(campaigns, id);
  delete campaigns[id];
  if (!saveCampaigns()) {
    restoreField(campaigns, id, previousRecord);
    return false;
  }
  stores.delete(id);
  const dir = campaignDir(id);
  if (dir !== DATA_DIR) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error(`Error removing campaign files for ${id}:`, e); }
  }
  evictFromCampaign(id, () => true);
  return true;
}

// Send seated sockets back to the lobby (campaign deleted, or access lost).
function evictFromCampaign(id, shouldEvict) {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId !== id || !shouldEvict(sock)) continue;
    leaveCampaignRoomsFor(sock, id);
    sock.campaignId = null;
    sock.currentMapKey = null;
    sock.contextMapKey = null;
    sock.join('lobby');
    sock.emit('campaign-deleted', { id });
  }
}

// Presence roster: every logged-in socket inside each campaign and where it is.
// Broadcast per campaign room (usernames aren't secret); the GM View tool uses
// it to list live players it can steer. Fired on login, join/leave, join-map
// and disconnect, plus a lobby-level campaign list refresh.
function broadcastPresence() {
  const byCampaign = new Map();
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || !sock.campaignId) continue;
    let list = byCampaign.get(sock.campaignId);
    if (!list) { list = []; byCampaign.set(sock.campaignId, list); }
    list.push({
      username: sock.username,
      mapKey: sock.currentMapKey || 'world',
      isGM: isCampaignGMFor(sock.campaignId, sock.username)
    });
  }
  for (const [campaignId, players] of byCampaign) {
    io.to(campRoom(campaignId)).emit('players-updated', { players });
  }
  pushCampaignList();
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
      if (!isCampaignGM(username) && obj.characterData.owner !== username) continue;
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
// Live refresh: whenever a character token is added/moved/deleted anywhere in
// the active campaign, every socket of that campaign gets its (personalized)
// instance list again.
function pushCharacterInstances() {
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (sock.username && sock.campaignId === campaignId) {
      sock.emit('character-instances', { instances: characterInstancesFor(sock.username) });
    }
  }
}

// Dungeon index (GM right-menu "Dungeons" list): every pocket map of the active
// campaign with the portals that lead into it, wherever they sit. A pocket whose
// entry portal was deleted still lists, so it is never orphaned. GM only — the
// list would tell players which dungeons exist.
function dungeonIndex() {
  const dungeons = new Map();
  for (const key of Object.keys(maps)) {
    const meta = maps[key].meta || {};
    if (meta.kind !== 'pocket') continue;
    dungeons.set(key, {
      key,
      name: meta.name || 'Pocket',
      width: meta.width || 0,
      height: meta.height || 0,
      parentKey: meta.parentKey || null,
      portals: []
    });
  }
  for (const key of Object.keys(maps)) {
    const meta = maps[key].meta || {};
    for (const obj of Object.values(maps[key].objects || {})) {
      if (obj.type !== 'portal' || !dungeons.has(obj.target)) continue;
      dungeons.get(obj.target).portals.push({
        id: obj.id,
        mapKey: key,
        mapName: meta.kind === 'pocket' ? (meta.name || 'Pocket') : 'World',
        name: obj.name || 'Portal',
        position: obj.position || { x: 0, y: 0, z: 0 }
      });
    }
  }
  return [...dungeons.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function pushDungeons() {
  const campaignId = activeCampaignId();
  let dungeons = null;
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || sock.campaignId !== campaignId || !isCampaignGM(sock.username)) continue;
    sock.emit('dungeon-list', { dungeons: dungeons || (dungeons = dungeonIndex()) });
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

// One-time migration: the hex ladder gained a layer (Continent 60mi > Kingdom 6mi
// > Province 1mi > Tactical). Old depth-2 tactical maps (world/q,r/q,r) become
// Province hex layers, so their content moves to the center sub-hex (.../0,0).
// Portal targets and pocket parent links pointing at moved keys are rewritten.
function migrateHexLayerRename() {
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

// Custom races/classes are table-shared. Monster definitions are scoped below
// so players do not receive every GM-authored stat block over the socket.
const emptyHomebrewDB = () => Object.fromEntries(
  Object.values(HOMEBREW_COLLECTIONS).map(collection => [collection, {}])
);
const loadedHomebrewDB = loadJSON('homebrew.json', emptyHomebrewDB(), validHomebrewSaveData);
let homebrewDB = emptyHomebrewDB();
for (const [type, collection] of Object.entries(HOMEBREW_COLLECTIONS)) {
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
// With model packs installed the manifest URL answers with the merged view
// (pack entries over the committed ones); without packs the static file serves.
app.get('/assets/monsters/manifest.json', (req, res, next) => {
  if (!mergedMonsterManifest) return next();
  res.set('Cache-Control', 'no-cache').type('application/json').send(mergedMonsterManifest);
});
app.get('/assets/characters/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/json').send(characterLooksManifest);
});
// The character kit without the private race parts this checkout lacks
// (lib/character-packs.cjs loadCharacterKit), ahead of the static mount.
app.get('/assets/characters/mh/kit.json', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/json').send(characterKitJSON);
});
app.use('/packs', express.static(MONSTER_PACKS_DIR, { dotfiles: 'ignore', index: false }));
app.use(express.static(PUBLIC_DIR));
app.use('/data/srd', express.static(path.join(__dirname, 'data', 'srd')));

// Routes. root+relative (not one absolute path) so sendFile's dotfile check
// doesn't reject the whole app when the repo lives under a dot-directory
// (e.g. a git worktree inside a hidden folder).
// The home hub (lobby) is the front door; /lobby stays as an alias.
app.get('/', (req, res) => res.sendFile('lobby.html', { root: PUBLIC_DIR }));
app.get('/creator', (req, res) => res.sendFile('creator.html', { root: PUBLIC_DIR }));
app.get('/lobby', (req, res) => res.sendFile('lobby.html', { root: PUBLIC_DIR }));
app.get('/gm', (req, res) => res.sendFile('gm.html', { root: PUBLIC_DIR }));
app.get('/player', (req, res) => res.sendFile('player.html', { root: PUBLIC_DIR }));
app.get('/homebrew', (req, res) => res.sendFile('homebrew.html', { root: PUBLIC_DIR }));

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// What the login modal should ask for. `setup` (create the host account) is
// only offered to the host computer itself.
app.get('/auth/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    open: auth.open,
    ...(auth.open && process.env.THREEDX_DEMO === '1' ? { demo: true } : {}),   // npm run demo
    setup: auth.needsSetup() ? (isLoopbackAddress(req.socket.remoteAddress) ? 'here' : 'elsewhere') : null
  });
});

// Helper: Check if user is the global GM — the host account (lib/auth.cjs).
// Mutations below enforce this role and ownership.
function isGM(username) {
  return auth.isHost(username);
}

function homebrewPayloadFor(username) {
  const monsters = Object.values(homebrewDB.monsters);
  const payload = {};
  for (const collection of Object.values(HOMEBREW_COLLECTIONS)) {
    payload[collection] = Object.values(homebrewDB[collection]);
  }
  payload.monsters = isGM(username) ? monsters : monsters.filter(monster => monster.owner === username);
  return payload;
}

// Helper: Check if user can access character
function canAccessCharacter(username, character) {
  if (!username || !character) return false;
  return isCampaignGM(username) || character.owner === username;
}

// Character lists are role-scoped in one place so every request path gives the
// GM the complete roster while players only receive their own characters.
function charactersAccessibleTo(username) {
  const characters = Object.values(charactersDB);
  return isCampaignGM(username) ? characters : characters.filter(char =>
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
  for (const [key, allowed] of Object.entries(CHARACTER_APPEARANCE_ENUMS)) {
    if (allowed.has(source[key])) appearance[key] = source[key];
  }
  if (Array.isArray(source.traits)) {
    appearance.traits = CHARACTER_TRAITS.filter(trait => source.traits.includes(trait));
  }
  if (typeof source.look === 'string' && LOOK_KEY_RE.test(source.look)) appearance.look = source.look;
  if (isRecord(source.form)) {
    appearance.form = {};
    for (const key of CHARACTER_FORM_KEYS) {
      appearance.form[key] = boundedScalarNumber(source.form[key], 0, 1, key === 'age' ? 0 : 0.5);
    }
  }
  if (isRecord(source.details)) {
    appearance.details = {};
    for (const [key, raw] of Object.entries(source.details).slice(0, MAX_CHARACTER_DETAILS)) {
      const value = boundedScalarNumber(raw, -1, 1, 0);
      if (CHARACTER_KIT_ID_RE.test(key) && value) appearance.details[key] = value;
    }
  }
  if (isRecord(source.wear)) {
    appearance.wear = {};
    for (const slot of CHARACTER_WEAR_SLOTS) {
      const id = source.wear[slot];
      // '' is a choice too: "nothing in this slot", not "use the default".
      if (id === '' || (typeof id === 'string' && CHARACTER_KIT_ID_RE.test(id))) appearance.wear[slot] = id;
    }
  }
  if (source.showArmor === false) appearance.showArmor = false;
  for (const key of ['skin', 'eyeColor']) {
    if (typeof source[key] === 'string' && CHARACTER_KIT_ID_RE.test(source[key])) appearance[key] = source[key];
  }
  return appearance;
}

function sanitizeCharacterTextArray(raw, maxItems, maxLength) {
  if (!Array.isArray(raw)) return [];
  const values = [];
  for (const candidate of raw.slice(0, maxItems)) {
    const value = boundedString(candidate, maxLength);
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

// Pick-N feature choices: { "<source>|<feature name>": ["option name", ...] }.
function sanitizeCharacterChoices(raw) {
  const choices = {};
  if (!isRecord(raw)) return choices;
  for (const [rawKey, picked] of Object.entries(raw).slice(0, 64)) {
    const key = boundedString(rawKey, 240);
    const options = sanitizeCharacterTextArray(picked, 8, 120);
    if (key && key !== '__proto__' && options.length) choices[key] = options;
  }
  return choices;
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
    feats: sanitizeReferenceArray(raw.feats, 24, 96),
    expertise: sanitizeReferenceArray(raw.expertise, 18, 96),
    languages: sanitizeCharacterTextArray(raw.languages, 24, 40),
    choices: sanitizeCharacterChoices(raw.choices),
    notes: boundedMultilineText(raw.notes, 8000),
    color: appearance.colors.torso,
    // stats is the schema-v1/token-renderer alias retained by creator v2.
    stats: { ...abilities }
  };
  // Optional sheet extras: only stored when the player filled them in.
  if (isRecord(raw.asi)) {
    const asi = {};
    for (const ability of CHARACTER_ABILITIES) {
      const points = boundedScalarInteger(raw.asi[ability], 0, 12, 0);
      if (points > 0) asi[ability] = points;
    }
    if (Object.keys(asi).length) character.asi = asi;
  }
  if (isRecord(raw.personality)) {
    const personality = {};
    for (const key of ['traits', 'ideals', 'bonds', 'flaws', 'specialty']) {
      const text = boundedMultilineText(raw.personality[key], 600);
      if (text) personality[key] = text;
    }
    if (Object.keys(personality).length) character.personality = personality;
  }
  if (requestedId) character.id = requestedId;
  if (isRecord(raw.hp)) {
    const current = boundedScalarInteger(raw.hp.current, 0, 999, null);
    if (current != null) character.hp = { current };
  }
  // Experience points (XP mode campaigns): optional, only stored when the
  // sheet carries one. The GM's award-xp writes it too.
  const xp = boundedScalarInteger(raw.xp, 0, 100000000, null);
  if (xp != null) character.xp = xp;
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
  // "Recharge 5-6": combat gates the action's reuse on a d6 each turn.
  if (isRecord(raw.usage) && raw.usage.type === 'recharge on roll') {
    const minimum = boundedScalarInteger(raw.usage.min_value, 2, 6, null);
    if (minimum != null) action.usage = { type: 'recharge on roll', dice: '1d6', min_value: minimum };
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
  return sanitizeRulesHomebrew(type, raw);
}

function emitCharacterChange(event, payload, owner) {
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId !== campaignId) continue;
    if (isCampaignGMFor(campaignId, sock.username) || sock.username === owner) sock.emit(event, payload);
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
  if (!isCampaignGM(username) && type !== 'character') return { error: 'GM only' };
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
    if (!isCampaignGM(username) && playerCharacterInstanceCount(username) >= MAX_PLAYER_CHARACTER_INSTANCES) {
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

  const monsterVariant = type === 'token' && isRecord(object.monsterData)
    ? sanitizeMonsterVariant(object.monsterData.index, object.monsterVariant)
    : null;
  if (monsterVariant) object.monsterVariant = monsterVariant;
  else delete object.monsterVariant;

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
  // Vision fields (shared/vision.js). A light may sit on anything; senses and
  // the GM's hidden/invisible flags only mean something on creatures.
  const light = vision.normalizeLight(object.light);
  if (light) object.light = light; else delete object.light;
  const creature = type === 'token' || type === 'character';
  if (creature && isRecord(object.senses)) object.senses = vision.normalizeSenses(object.senses);
  else delete object.senses;
  for (const flag of ['hidden', 'invisible']) {
    if (object[flag] === true && isCampaignGM(username) && (creature || flag === 'hidden')) object[flag] = true;
    else delete object[flag];
  }
  if (type !== 'wall') delete object.doors;
  delete object.pose;   // only `use-prop` puts a character on furniture
  if (type === 'prop') {
    if (!PROP_KINDS.includes(object.kind)) return { error: 'Unknown prop' };
    object.rot = Math.round(boundedNumber(object.rot, 0, 3, 0));
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
    object.style = ['stone', 'wood', 'plaster', 'dungeon', 'sight'].includes(object.style) ? object.style : 'stone';
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

// Door states ride beside `segments`: only cells that ARE doors keep one
// ('open' or 'locked'; a closed, unlocked door stores nothing).
function sanitizeWallDoors(wall, raw) {
  if (!Array.isArray(raw) || !Array.isArray(wall.segments)) return null;
  const doors = wall.segments.map((kind, i) =>
    (kind === 'door' && vision.DOOR_STATES.includes(raw[i])) ? raw[i] : null);
  return doors.some(Boolean) ? doors : null;
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
  if (object.type === 'wall') {
    const doors = sanitizeWallDoors(object, object.doors);
    if (doors) object.doors = doors; else delete object.doors;
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

// ===== Table log (rolls.json, one per campaign store) =====
// Every roll made at the table — ability checks, saves, skills, spells cast
// outside the tracker, free dice — plus a mirror of the combat log, kept so
// the table can scroll back after the fight or the session is over. The
// server rolls; clients only say what is being rolled and with what bonus
// (the same advisory trust as combat-set-stats: the server loads no SRD).
const TABLE_LOG_LIMIT = 400;
// Spent spell slots and feature pools per character (pools.json in the
// campaign store). Only what is USED is kept — the sheet says how many there
// are, so a level-up needs no migration:
//   { [charId]: { slots: { level: used }, pact: used, res: { key: { used, recharge } },
//                 hd: { die: used }, hdOpen, vit: { maxHP, con, hd: { die: max } } } }
// A rest clears them: a long rest everything (and half the hit dice come
// back), a short rest the pact slots and the pools that recharge on a short
// rest — and it opens the hit dice (`hdOpen`) until the character acts again.
// `vit` is what the owner's screen last derived from the sheet (set-vitals):
// the server has no SRD, and needs these to heal a character on its own.
// Pending rest requests ride in the same file.
const POOLS_FILE = 'pools.json';
const REST_KINDS = ['short', 'long'];
const HIT_DICE = [6, 8, 10, 12];
function poolInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function poolsDB() {
  if (!activeStore) return {};
  if (!activeStore.pools) {
    const saved = loadJSON(POOLS_FILE, { chars: {} },
      (value) => isRecord(value) && isRecord(value.chars), activeStore.dir);
    const chars = {};
    for (const [id, raw] of Object.entries(saved.chars)) {
      if (!isRecord(raw)) continue;
      const pool = { slots: {}, pact: poolInt(raw.pact, 0, 20, 0), res: {}, hd: {} };
      for (let level = 1; level <= 9; level++) {
        const used = poolInt(raw.slots && raw.slots[level], 0, 20, 0);
        if (used) pool.slots[level] = used;
      }
      for (const die of HIT_DICE) {
        const used = poolInt(raw.hd && raw.hd[die], 0, 20, 0);
        if (used) pool.hd[die] = used;
      }
      if (raw.hdOpen === true) pool.hdOpen = true;
      // The spell held outside a fight; `dc` is a concentration check owed.
      if (isRecord(raw.conc) && typeof raw.conc.name === 'string' && raw.conc.name.trim()) {
        pool.conc = { name: raw.conc.name.trim().slice(0, 40) };
        const dc = poolInt(raw.conc.dc, 10, 60, 0);
        if (dc) pool.conc.dc = dc;
      }
      const vit = sanitizeVitals(raw.vit);
      if (vit) pool.vit = vit;
      for (const [key, value] of Object.entries(isRecord(raw.res) ? raw.res : {}).slice(0, 40)) {
        if (!isRecord(value)) continue;
        const used = poolInt(value.used, 0, 999, 0);
        if (used) pool.res[String(key).slice(0, 40)] = { used, recharge: value.recharge === 'long' ? 'long' : 'short' };
      }
      chars[String(id).slice(0, 80)] = pool;
    }
    activeStore.pools = chars;
    activeStore.restRequests = (Array.isArray(saved.requests) ? saved.requests : []).filter(request =>
      isRecord(request) && typeof request.id === 'string' && typeof request.charId === 'string' &&
      REST_KINDS.includes(request.kind)).slice(-40).map(request => ({
        id: request.id.slice(0, 20), charId: request.charId.slice(0, 80), name: String(request.name || 'Adventurer').slice(0, 80),
        owner: String(request.owner || '').slice(0, 40), kind: request.kind, ts: Number(request.ts) || 0
      }));
  }
  return activeStore.pools;
}
function sanitizeVitals(raw) {
  if (!isRecord(raw)) return null;
  const vit = { maxHP: poolInt(raw.maxHP, 1, 999, 1), con: poolInt(raw.con, -5, 10, 0), hd: {} };
  for (const die of HIT_DICE) {
    const max = poolInt(raw.hd && raw.hd[die], 0, 20, 0);
    if (max) vit.hd[die] = max;
  }
  return vit;
}
function poolOf(charId) {
  const db = poolsDB();
  if (!hasOwn(db, charId)) db[charId] = { slots: {}, pact: 0, res: {}, hd: {} };
  return db[charId];
}
function poolIsEmpty(pool) {
  return !pool.pact && !pool.vit && !pool.hdOpen && !pool.conc && !Object.keys(pool.slots).length &&
    !Object.keys(pool.res).length && !Object.keys(pool.hd || {}).length;
}
function saveRestState() {
  return saveJSON(POOLS_FILE, { chars: poolsDB(), requests: restList() });
}
function savePools(changedIds) {
  const db = poolsDB();
  for (const id of Object.keys(db)) if (poolIsEmpty(db[id])) delete db[id];
  saveRestState();
  const room = io.to(campRoom(activeCampaignId()));
  for (const charId of changedIds) room.emit('pools-updated', { charId, pool: db[charId] || null });
}
// Combat spends from the combatant; this copies what is left back to the
// character so it carries past the fight (called on every combat broadcast).
function syncCombatPools(combat) {
  if (!combat || !isRecord(combat.combatants)) return;
  const changed = [];
  for (const c of Object.values(combat.combatants)) {
    if (c.kind !== 'character' || !c.charId || c.statsPending || !isRecord(c.slotMax)) continue;
    const pool = poolOf(c.charId);
    const before = JSON.stringify(pool);
    for (let level = 1; level <= 9; level++) {
      const used = Math.max(0, (c.slotMax[level] || 0) - ((c.slots && c.slots[level]) || 0));
      if (used) pool.slots[level] = used; else delete pool.slots[level];
    }
    for (const [key, resource] of Object.entries(c.resources || {})) {
      if (resource.recharge !== 'short' && resource.recharge !== 'long') continue;
      const used = Math.max(0, resource.max - resource.current);
      if (used) pool.res[key] = { used, recharge: resource.recharge }; else delete pool.res[key];
    }
    if (isRecord(c.pact)) pool.pact = Math.max(0, c.pact.max - c.pact.left);
    // The spell it holds leaves the fight with it (checks are the tracker's).
    if (isRecord(c.concentration)) pool.conc = { name: c.concentration.name }; else delete pool.conc;
    delete pool.hdOpen; // a fight ends the rest
    if (JSON.stringify(pool) !== before) changed.push(c.charId);
  }
  if (changed.length) savePools(changed);
}
// Every combatant (any map of this campaign) that is this character.
function combatantsOfCharacter(charId) {
  const found = [];
  for (const [key, map] of Object.entries(maps)) {
    if (!map || !map.combat || !isRecord(map.combat.combatants)) continue;
    for (const c of Object.values(map.combat.combatants)) if (c.charId === charId) found.push({ key, c });
  }
  return found;
}
function restList() {
  poolsDB();
  return (activeStore && activeStore.restRequests) || [];
}
function setRestList(list) {
  poolsDB();
  if (activeStore) activeStore.restRequests = list;
  saveRestState();
}

// --- Campaign journal (journal.json in the campaign store) ---
// The GM's campaign-scoped notebook: quest/NPC/lore/handout notes (each
// either party-visible or GM-only), the shared party treasury, and the XP
// log with its mode. Players receive only party-visible entries; the
// treasury and XP log are party information.
const JOURNAL_FILE = 'journal.json';
const JOURNAL_KINDS = ['quest', 'npc', 'lore', 'handout'];
const JOURNAL_LIMIT = 200;
const JOURNAL_TEXT_LIMIT = 4000;
const TREASURY_COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];
function journalInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function journalDB() {
  if (!activeStore) return null;
  if (!activeStore.journal) {
    const saved = loadJSON(JOURNAL_FILE, { entries: [] },
      value => isRecord(value) && (!hasOwn(value, 'entries') || Array.isArray(value.entries)),
      activeStore.dir);
    const entries = [];
    for (const raw of (Array.isArray(saved.entries) ? saved.entries : []).slice(-JOURNAL_LIMIT)) {
      if (!isRecord(raw)) continue;
      const text = boundedMultilineText(raw.text, JOURNAL_TEXT_LIMIT);
      if (!text) continue;
      entries.push({
        id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8),
        title: boundedText(raw.title, 120) || 'Untitled',
        text,
        kind: JOURNAL_KINDS.includes(raw.kind) ? raw.kind : 'quest',
        visible: raw.visible === 'gm' ? 'gm' : 'party',
        at: journalInt(raw.at, 0, 0x7fffffffffff, 0),
        updated: journalInt(raw.updated, 0, 0x7fffffffffff, 0)
      });
    }
    const coins = {};
    const rawTreasury = isRecord(saved.treasury) ? saved.treasury : {};
    for (const coin of TREASURY_COINS) {
      const value = journalInt(rawTreasury[coin], 0, 100000000, 0);
      if (value) coins[coin] = value;
    }
    const rawXp = isRecord(saved.xp) ? saved.xp : {};
    const awards = [];
    for (const raw of (Array.isArray(rawXp.awards) ? rawXp.awards : []).slice(-JOURNAL_LIMIT)) {
      if (!isRecord(raw)) continue;
      const text = boundedText(raw.text, 240);
      const xp = journalInt(raw.xp, 0, 100000000, 0);
      if (!text && !xp) continue;
      awards.push({
        id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8),
        at: journalInt(raw.at, 0, 0x7fffffffffff, 0),
        text: text || `${xp} XP`,
        xp,
        charIds: sanitizeReferenceArray(raw.charIds, 32, 80)
      });
    }
    activeStore.journal = {
      entries,
      treasury: coins,
      xp: { mode: rawXp.mode === 'xp' ? 'xp' : 'milestone', awards }
    };
  }
  return activeStore.journal;
}
function saveJournal() {
  return activeStore && saveJSON(JOURNAL_FILE, {
    entries: activeStore.journal.entries,
    treasury: activeStore.journal.treasury,
    xp: activeStore.journal.xp
  }, activeStore.dir);
}
// Role-scoped snapshot: journal notes filter by `visible`, treasury and the
// XP log are party information for everyone at the table.
function journalPayloadFor(username) {
  const journal = journalDB();
  if (!journal) return { entries: [], treasury: {}, xp: { mode: 'milestone', awards: [] } };
  const gm = isCampaignGMFor(activeCampaignId(), username);
  return {
    entries: gm ? journal.entries : journal.entries.filter(entry => entry.visible === 'party'),
    treasury: journal.treasury,
    xp: journal.xp
  };
}
// Push the journal to every socket of the campaign, each one role-scoped.
function pushJournal() {
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId !== campaignId || !sock.username) continue;
    sock.emit('journal', journalPayloadFor(sock.username));
  }
}
// The slot a combatant burns to cast a spell of `level`: an ordinary slot of
// the level asked for (`wanted`, upcasting) or of the spell's own level, else
// the warlock's pact slot. → the level it is cast at, or 0 when none is left.
function takeCombatSlot(c, level, wanted) {
  const tryLevel = (at) => {
    if (c.slots && (c.slots[at] || 0) > 0) { c.slots[at] -= 1; return at; }
    if (isRecord(c.pact) && c.pact.level === at && c.pact.left > 0) { c.pact.left -= 1; return at; }
    return 0;
  };
  const want = poolInt(wanted, 1, 9, 0);
  if (want > level) return tryLevel(want);
  const exact = tryLevel(level);
  if (exact) return exact;
  if (isRecord(c.pact) && c.pact.level > level && c.pact.left > 0) { c.pact.left -= 1; return c.pact.level; }
  return 0;
}
function sanitizePact(raw, used = 0) {
  if (!isRecord(raw)) return null;
  const level = poolInt(raw.level, 1, 9, 0);
  const max = poolInt(raw.max != null ? raw.max : raw.count, 0, 20, 0);
  if (!level || !max) return null;
  return { level, max, left: raw.left != null ? poolInt(raw.left, 0, max, max) : Math.max(0, max - used) };
}
function emitRestRequests() {
  io.to(campRoom(activeCampaignId())).emit('rest-requests', { requests: restList() });
}
// → an error string, or null once the rest is taken.
function applyRest(charId, kind, grantedBy) {
  const character = ownValue(charactersDB, charId);
  if (!character) return 'Character not found';
  if (combatantsOfCharacter(charId).length) return `${character.name || 'That character'} is in a fight: end it first`;
  const pool = poolOf(charId);
  let regained = 0;
  if (kind === 'long') {
    pool.slots = {}; pool.pact = 0; pool.res = {};
    delete pool.hdOpen;
    delete pool.conc;
    if (banishWhere(summon => summon.charId === charId)) { saveMaps(); flushSummonChanges(); }
    // Half the hit dice come back (at least one), biggest dice first.
    const total = pool.vit ? Object.values(pool.vit.hd).reduce((sum, n) => sum + n, 0) : 0;
    let back = total ? Math.max(1, Math.floor(total / 2)) : 99;
    for (const die of [...HIT_DICE].reverse()) {
      const used = pool.hd[die] || 0;
      const returned = Math.min(used, back);
      if (returned) { pool.hd[die] = used - returned; back -= returned; regained += returned; }
      if (!pool.hd[die]) delete pool.hd[die];
    }
    if (pool.vit) applyCharacterHP(charId, pool.vit.maxHP);
  } else {
    pool.pact = 0;
    for (const [key, value] of Object.entries(pool.res)) if (value.recharge !== 'long') delete pool.res[key];
    pool.hdOpen = true;
  }
  savePools([charId]);
  io.to(campRoom(activeCampaignId())).emit('rest-taken', { charId, kind, owner: character.owner || null });
  const name = character.name || 'A character';
  appendTableLog([{
    id: crypto.randomUUID().slice(0, 8), ts: Date.now(), kind: 'roll', user: grantedBy, gm: true,
    actor: name, label: kind === 'long' ? 'takes a long rest' : 'takes a short rest',
    note: kind === 'long'
      ? `Hit points, spell slots and every feature are restored${regained ? `; ${regained} hit ${regained === 1 ? 'die' : 'dice'} regained` : ''}.`
      : 'Pact slots and short-rest features are restored. Hit dice can be spent to heal.',
    text: `${name} takes a ${kind} rest`
  }]);
  return null;
}

const TABLE_LOG_FILE = 'rolls.json';
function tableLog() {
  if (!activeStore) return [];
  if (!activeStore.rolls) {
    const saved = loadJSON(TABLE_LOG_FILE, { entries: [] },
      (value) => isRecord(value) && Array.isArray(value.entries), activeStore.dir);
    activeStore.rolls = saved.entries.filter(isRecord).slice(-TABLE_LOG_LIMIT);
  }
  return activeStore.rolls;
}
function saveTableLog() {
  return saveJSON(TABLE_LOG_FILE, { entries: tableLog() });
}
// A GM-only roll reaches the GM and whoever made it.
function tableEntryVisibleTo(username, entry) {
  return entry.gmOnly !== true || entry.user === username || isCampaignGM(username);
}
function appendTableLog(entries) {
  if (!activeStore || !entries.length) return;
  const log = tableLog();
  log.push(...entries);
  if (log.length > TABLE_LOG_LIMIT) log.splice(0, log.length - TABLE_LOG_LIMIT);
  saveTableLog();
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || sock.campaignId !== campaignId) continue;
    for (const entry of entries) {
      if (tableEntryVisibleTo(sock.username, entry)) sock.emit('roll-logged', entry);
    }
  }
}

// Table chat (chat.json per campaign): OOC talk with private whispers, kept
// per campaign so the history outlives a refresh. A whisper is only ever
// delivered to and shown for its two speakers — not even the GM reads it.
const CHAT_FILE = 'chat.json';
const CHAT_LIMIT = 200;
const CHAT_TEXT_LIMIT = 500;
const CHAT_GAP_MS = 400;
function chatDB() {
  if (!activeStore) return [];
  if (!activeStore.chat) {
    const saved = loadJSON(CHAT_FILE, { messages: [] },
      (value) => isRecord(value) && Array.isArray(value.messages), activeStore.dir);
    const messages = [];
    for (const raw of saved.messages.slice(-CHAT_LIMIT)) {
      if (!isRecord(raw)) continue;
      const text = boundedText(raw.text, CHAT_TEXT_LIMIT);
      const from = boundedText(raw.from, MAX_USERNAME_LENGTH);
      if (!text || !from) continue;
      const at = Number(raw.at);
      messages.push({
        id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8),
        at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0,
        from,
        to: boundedText(raw.to, MAX_USERNAME_LENGTH) || null,
        text
      });
    }
    activeStore.chat = messages;
  }
  return activeStore.chat;
}
function saveChat() {
  return activeStore && saveJSON(CHAT_FILE, { messages: chatDB() });
}
// OOC reaches the whole table; a whisper stays between its two speakers.
function chatEntryVisibleTo(username, entry) {
  return !entry.to || sameUser(entry.to, username) || sameUser(entry.from, username);
}
function deliverChat(message) {
  const campaignId = activeCampaignId();
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username || sock.campaignId !== campaignId) continue;
    if (chatEntryVisibleTo(sock.username, message)) sock.emit('chat-message', message);
  }
}

// Dice macros (macros.json): a personal saved roll per campaign — a UI
// shortcut, not table state, so a list only ever reaches its owner's sockets.
const MACROS_FILE = 'macros.json';
const MACROS_LIMIT = 50;
function sanitizeMacro(raw) {
  if (!isRecord(raw)) return null;
  const roll = {};
  if (isRecord(raw.d20)) roll.d20 = { bonus: boundedInteger(raw.d20.bonus, -50, 50, 0) };
  if (Array.isArray(raw.dice)) {
    const dice = raw.dice.slice(0, 4).filter(isRecord)
      .map(part => ({ expr: boundedString(part.expr, 40), type: boundedString(part.type, 24) }))
      .filter(part => part.expr);
    if (dice.length) roll.dice = dice;
  }
  if (!roll.d20 && !roll.dice) return null;
  const dc = boundedInteger(raw.dc, 0, 99, 0);
  const note = boundedString(raw.note, 240);
  const name = boundedString(raw.name, 40) || 'Roll';
  return {
    id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8),
    name,
    label: boundedString(raw.label, 120) || name,
    owner: boundedText(raw.owner, MAX_USERNAME_LENGTH),
    ...(note ? { note } : {}),
    ...(dc ? { dc } : {}),
    ...(raw.gmOnly === true ? { gmOnly: true } : {}),
    ...roll
  };
}
function macrosDB() {
  if (!activeStore) return [];
  if (!activeStore.macros) {
    const saved = loadJSON(MACROS_FILE, { macros: [] },
      (value) => isRecord(value) && Array.isArray(value.macros), activeStore.dir);
    activeStore.macros = saved.macros.slice(-MACROS_LIMIT).map(sanitizeMacro).filter(Boolean);
  }
  return activeStore.macros;
}
function saveMacros() {
  return activeStore && saveJSON(MACROS_FILE, { macros: macrosDB() });
}
function deliverMacros(username) {
  const campaignId = activeCampaignId();
  const payload = { macros: macrosDB().filter(macro => sameUser(macro.owner, username)) };
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId === campaignId && sameUser(sock.username, username)) sock.emit('macros', payload);
  }
}

// GM bookmarks (bookmarks.json): named camera spots over this campaign's
// maps — a GM-only authoring aid, so only GM sockets ever receive the list.
const BOOKMARKS_FILE = 'bookmarks.json';
const BOOKMARKS_LIMIT = 40;
function bookmarkCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function sanitizePose(raw) {
  if (!isRecord(raw) || !isRecord(raw.pos) || !isRecord(raw.look)) return null;
  const nums = ['x', 'y', 'z'].map(key => [bookmarkCoord(raw.pos[key]), bookmarkCoord(raw.look[key])]);
  if (nums.some(([pos, look]) => pos == null || look == null)) return null;
  return {
    pos: { x: nums[0][0], y: nums[1][0], z: nums[2][0] },
    look: { x: nums[0][1], y: nums[1][1], z: nums[2][1] }
  };
}
function bookmarksDB() {
  if (!activeStore) return [];
  if (!activeStore.bookmarks) {
    const saved = loadJSON(BOOKMARKS_FILE, { bookmarks: [] },
      (value) => isRecord(value) && Array.isArray(value.bookmarks), activeStore.dir);
    const bookmarks = [];
    for (const raw of saved.bookmarks.slice(-BOOKMARKS_LIMIT)) {
      if (!isRecord(raw)) continue;
      const pose = sanitizePose(raw.pose);
      const name = boundedText(raw.name, 40);
      const mapKey = boundedString(raw.mapKey, 80);
      if (!pose || !name || !mapKey) continue;
      bookmarks.push({ id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8), name, mapKey, pose });
    }
    activeStore.bookmarks = bookmarks;
  }
  return activeStore.bookmarks;
}
function saveBookmarks() {
  return activeStore && saveJSON(BOOKMARKS_FILE, { bookmarks: bookmarksDB() });
}
function deliverBookmarks() {
  const campaignId = activeCampaignId();
  const payload = { bookmarks: bookmarksDB() };
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId === campaignId && sock.username && isCampaignGMFor(campaignId, sock.username)) sock.emit('bookmarks', payload);
  }
}

// --- GM encounter library: saved groups of monsters to drop on the map ---
const ENCOUNTERS_FILE = 'encounters.json';
const ENCOUNTERS_LIMIT = 25;
const ENCOUNTER_ROW_MAX = 12;
const ENCOUNTER_TOKENS_MAX = 40;
function sanitizeEncounter(raw) {
  if (!isRecord(raw)) return null;
  const name = boundedText(raw.name, 40);
  if (!name) return null;
  const members = [];
  let tokens = 0;
  for (const entry of (Array.isArray(raw.members) ? raw.members : [])) {
    if (!isRecord(entry)) continue;
    const index = boundedString(entry.index, 80);
    const count = boundedInteger(entry.count, 1, 12, 1);
    if (!index || tokens + count > ENCOUNTER_TOKENS_MAX) continue;
    members.push({ index, count });
    tokens += count;
    if (members.length >= ENCOUNTER_ROW_MAX) break;
  }
  if (!members.length) return null;
  return { id: boundedString(raw.id, 20) || crypto.randomUUID().slice(0, 8), name, members };
}
function encountersDB() {
  if (!activeStore) return [];
  if (!activeStore.encounters) {
    const saved = loadJSON(ENCOUNTERS_FILE, { encounters: [] },
      (value) => isRecord(value) && Array.isArray(value.encounters), activeStore.dir);
    const encounters = [];
    for (const raw of saved.encounters.slice(-ENCOUNTERS_LIMIT)) {
      const encounter = sanitizeEncounter(raw);
      if (encounter) encounters.push(encounter);
    }
    activeStore.encounters = encounters;
  }
  return activeStore.encounters;
}
function saveEncounters() {
  return activeStore && saveJSON(ENCOUNTERS_FILE, { encounters: encountersDB() });
}
function deliverEncounters() {
  const campaignId = activeCampaignId();
  const payload = { encounters: encountersDB() };
  for (const sock of io.sockets.sockets.values()) {
    if (sock.campaignId === campaignId && sock.username && isCampaignGMFor(campaignId, sock.username)) sock.emit('encounters', payload);
  }
}

// "2d6+1d4+3" → { expr, rolls, total }, or null when it is not a dice expression.
function rollExpression(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, '').toLowerCase();
  if (!text || text.length > 40 || !/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(text)) return null;
  const rolls = [];
  let total = 0;
  for (const term of text.match(/[+-]?(\d*d\d+|\d+)/g).slice(0, 8)) {
    const sign = term[0] === '-' ? -1 : 1;
    const body = term.replace(/^[+-]/, '');
    if (body.includes('d')) {
      const [count, sides] = body.split('d');
      const n = Math.max(1, Math.min(40, Number(count) || 1));
      const faces = Math.max(2, Math.min(1000, Number(sides) || 2));
      for (let i = 0; i < n; i++) { const roll = rollDie(faces); rolls.push(roll); total += sign * roll; }
    } else {
      total += sign * Math.min(10000, Number(body) || 0);
    }
  }
  return { expr: text, rolls, total };
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

// d20 with advantage/disadvantage (they cancel). → { d20, used, mode, text }
function rollD20(advantage, disadvantage) {
  const d20 = [rollDie(20)];
  const mode = advantage === disadvantage ? 0 : (advantage ? 1 : -1);
  if (mode) d20.push(rollDie(20));
  const used = mode > 0 ? Math.max(...d20) : Math.min(...d20);
  return { d20, used, mode, text: mode ? `[${d20.join(', ')}] → ${used}` : `${used}` };
}

// Roll a saving throw for a target combatant vs a DC, with everything that
// bears on it: the sheet's own modifiers (`saveMods`: advantage on some
// abilities, a flat bonus) and the conditions the tracker knows — a dodging
// creature has advantage on DEX, a restrained one disadvantage, a stunned or
// downed one fails STR and DEX outright, a blessed one adds 1d4.
function rollSave(target, ability, dc, concentration = false) {
  const mods = isRecord(target.saveMods) ? target.saveMods : {};
  const notes = [];
  const physical = ability === 'str' || ability === 'dex';
  const autoFail = physical && (hasEffect(target, 'stunned') || hasEffect(target, 'paralyzed') || hasEffect(target, 'down'));
  const advantage = (Array.isArray(mods.advantage) && mods.advantage.includes(ability)) ||
    (ability === 'dex' && hasEffect(target, 'dodging')) || (concentration && mods.concentration === true);
  const disadvantage = ability === 'dex' && hasEffect(target, 'restrained');
  const roll = rollD20(advantage, disadvantage);
  if (roll.mode > 0) notes.push('advantage');
  if (roll.mode < 0) notes.push('disadvantage');
  let mod = (target.saves && typeof target.saves[ability] === 'number') ? target.saves[ability] : 0;
  if (mods.bonus) mod += mods.bonus;
  let bless = 0;
  if (hasEffect(target, 'blessed')) { bless = rollDie(4); notes.push(`Bless +${bless}`); }
  const total = roll.used + mod + bless;
  if (autoFail) notes.push('fails automatically');
  return {
    d20: roll.d20, used: roll.used, mode: roll.mode, text: roll.text, mod, bless, total, vs: dc,
    success: !autoFail && total >= dc, autoFail, notes
  };
}

// What a save for damage leaves: all of it on a failure, half or none on a
// success — and with Evasion a DEX save for half becomes none / half.
function damageAfterSave(target, total, ability, saveSuccess, success) {
  const evasion = ability === 'dex' && saveSuccess === 'half' && isRecord(target.saveMods) && target.saveMods.evasion === true;
  if (success) {
    return {
      dealt: evasion || saveSuccess !== 'half' ? 0 : Math.floor(total / 2),
      note: evasion ? ' (Evasion)' : (saveSuccess === 'half' ? ' (half)' : '')
    };
  }
  return { dealt: evasion ? Math.floor(total / 2) : total, note: evasion ? ' (Evasion: half)' : '' };
}

// --- Areas and pending saving throws ----------------------------------------
// An area effect is aimed by its user and ruled on here: shared/aoe.js says
// which combatants stand in it (walls give total cover), the damage is rolled
// once, and every creature caught owes a saving throw. A save belongs to
// whoever plays the creature: it waits in `combat.pending` until its owner (or
// the GM) rolls it with `combat-save`. Saves the acting user controls anyway
// are rolled on the spot.

// The combatants an area catches. → { aim, targets } or an error string.
function areaTargets(key, combat, caster, shape, point) {
  const objects = (maps[key] && maps[key].objects) || {};
  const from = ownValue(objects, caster.id);
  if (!from || !from.position) return `${caster.name} is not on the map`;
  const aim = aoe.resolveAim(shape, from.position, isRecord(point) ? point : from.position);
  const creatures = [];
  for (const c of Object.values(combat.combatants)) {
    const object = ownValue(objects, c.id);
    if (object && object.position) creatures.push({ id: c.id, x: object.position.x, y: object.position.y, z: object.position.z });
  }
  const occ = visionState(key).occ;
  const selfOrigin = aim.kind === 'cone' || aim.kind === 'line' || aim.kind === 'self';
  const ids = aoe.caughtIn(aim, creatures, {
    exclude: selfOrigin ? caster.id : null,
    blocked: (source, creature) => vision.sightBlocked(occ, source.x, creature.y + 0.5, source.z, creature.x, creature.y + 0.5, creature.z)
  });
  return { aim, targets: ids.map(id => combat.combatants[id]) };
}

// Presentation hint for an aimed area: both screens draw the burst from it.
function areaFx(aim) {
  const round = (value) => Math.round(value * 100) / 100;
  return {
    kind: aim.kind, size: round(aim.size), width: round(aim.width),
    origin: [round(aim.origin.x), round(aim.origin.z)],
    center: [round(aim.center.x), round(aim.center.z)],
    dir: [round(aim.dir.x), round(aim.dir.z)]
  };
}

// Roll one creature's save against a pending effect and apply what follows.
function resolvePendingSave(key, combat, pending, target, stagedCharacterHP) {
  const state = pending.targets[target.id];
  if (!state || state.done) return;
  if (pending.conc) { // a concentration check: nothing but the spell is at stake
    pending.targets[target.id] = { done: true, success: true, total: 0 };
    if (!isRecord(target.concentration)) return;
    const check = rollSave(target, 'con', pending.dc, true);
    pushLog(key, combat, {
      kind: 'cast', actorName: target.name, spellName: target.concentration.name,
      save: { d20: check.d20, used: check.used, mod: check.mod, total: check.total, vs: check.vs, ability: 'con', success: check.success },
      text: `${target.name} concentrates on ${target.concentration.name} (DC ${pending.dc} CON): d20 ${check.text} ${fmtSigned(check.mod)}${check.bless ? ` + ${check.bless}` : ''} = ${check.total}${check.notes.length ? ` [${check.notes.join(', ')}]` : ''} — ${check.success ? 'HELD' : 'LOST'}`
    });
    pending.targets[target.id] = { done: true, success: check.success, total: check.total };
    if (!check.success) endConcentration(key, combat, target, 'loses concentration');
    return;
  }
  const save = rollSave(target, pending.saveAbility, pending.dc);
  let text = `${target.name} saves against ${pending.sourceName}'s ${pending.name} (DC ${pending.dc} ${pending.saveAbility.toUpperCase()}): d20 ${save.text} ${fmtSigned(save.mod)}${save.bless ? ` + ${save.bless}` : ''} = ${save.total}${save.notes.length ? ` [${save.notes.join(', ')}]` : ''} — ${save.success ? 'SAVE' : 'FAIL'}`;
  const entry = {
    kind: 'cast', actorName: pending.sourceName, targetName: target.name, spellName: pending.name,
    save: { d20: save.d20, used: save.used, mod: save.mod, total: save.total, vs: save.vs, ability: pending.saveAbility, success: save.success }
  };
  let dealt = 0;
  if (pending.damage) {
    const outcome = damageAfterSave(target, pending.damage.total, pending.saveAbility, pending.saveSuccess, save.success);
    dealt = outcome.dealt;
    entry.dmg = { expr: pending.damage.expr, rolls: pending.damage.rolls, total: dealt };
    text += ` · ${pending.damage.expr} → ${dealt}${pending.damageType ? ' ' + pending.damageType : ''}${outcome.note}`;
    const next = applyDamageToTarget(target, dealt, stagedCharacterHP);
    if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
  }
  // An effect held by concentration needs its caster still holding the spell.
  const holder = pending.linked ? ownValue(combat.combatants, pending.sourceId) : null;
  const lapsed = pending.linked && !(holder && isRecord(holder.concentration) && holder.concentration.name === pending.name);
  if (!save.success && pending.effect && lapsed) {
    text += ' — the spell has already ended';
  } else if (!save.success && pending.effect && !hasEffect(target, pending.effect)) {
    addEffect(target, pending.effect, false);
    if (holder) holdEffect(holder, target, pending.effect);
    text += ` — ${target.name} is ${CONDITION_LABELS[pending.effect].toLowerCase()}`;
  }
  entry.text = text;
  entry.fx = { react: true, target: target.id, ...(dealt > 0 || (!save.success && pending.effect && !lapsed) ? { landed: true } : {}) };
  pushLog(key, combat, entry);
  pending.targets[target.id] = { done: true, success: save.success, total: save.total };
}

function prunePending(combat) {
  if (!Array.isArray(combat.pending)) return;
  combat.pending = combat.pending.filter(pending =>
    Object.entries(pending.targets).some(([id, state]) => !state.done && hasOwn(combat.combatants, id)));
  if (!combat.pending.length) delete combat.pending;
}

// Roll every save still owed (the GM moves the fight on, or ends it).
function settlePending(key, combat, stagedCharacterHP) {
  for (const pending of (Array.isArray(combat.pending) ? combat.pending : [])) {
    for (const id of Object.keys(pending.targets)) {
      const target = ownValue(combat.combatants, id);
      if (target) resolvePendingSave(key, combat, pending, target, stagedCharacterHP);
    }
  }
  delete combat.pending;
}

// Announce a save-for-effect and collect the saves. spec: { name, verb,
// saveAbility, dc, saveSuccess, damage (dice), damageType, effect, note, aim };
// `rollsNow(target)` says whose save the acting user may roll at once.
function openSave(key, combat, source, spec, targets, stagedCharacterHP, rollsNow) {
  const damage = spec.damage ? rollDamage(spec.damage, false) : null;
  const pending = {
    id: crypto.randomUUID().slice(0, 8), sourceId: source.id, sourceName: source.name,
    name: spec.name, verb: spec.verb === 'casts' ? 'casts' : 'uses',
    saveAbility: spec.saveAbility, dc: spec.dc, saveSuccess: spec.saveSuccess === 'none' ? 'none' : 'half',
    damageType: spec.damageType || '', targets: {},
    ...(damage ? { damage: { expr: damage.expr, rolls: damage.rolls, total: damage.total } } : {}),
    ...(spec.effect ? { effect: spec.effect } : {}),
    ...(spec.effect && spec.linked ? { linked: true } : {})
  };
  for (const target of targets) pending.targets[target.id] = { done: false };
  const names = targets.map(target => target.name);
  const caught = !targets.length ? 'no one is caught'
    : spec.aim ? `${targets.length} caught — ${names.join(', ')}` : `on ${names.join(', ')}`;
  pushLog(key, combat, {
    kind: 'cast', actorName: source.name, spellName: spec.name,
    ...(damage ? { dmg: { expr: damage.expr, rolls: damage.rolls, total: damage.total } } : {}),
    ...(spec.quiet ? {} : { fx: {
      ...combatFx(source, targets.length === 1 && !spec.aim ? targets[0] : null, spec.name, spec.damageType),
      ...(spec.aim ? { area: areaFx(spec.aim) } : {}),
      ...(spec.form && !spec.aim ? { form: spec.form } : {})
    } }),
    text: `${source.name} ${pending.verb} ${spec.name}${spec.note || ''} (DC ${spec.dc} ${spec.saveAbility.toUpperCase()}${damage ? `, ${damage.expr} → ${damage.total}${spec.damageType ? ' ' + spec.damageType : ''}` : ''}): ${caught}`
  });
  for (const target of targets) {
    if (rollsNow(target)) resolvePendingSave(key, combat, pending, target, stagedCharacterHP);
  }
  if (Object.values(pending.targets).some(state => !state.done)) {
    combat.pending = [...(Array.isArray(combat.pending) ? combat.pending : []), pending].slice(-12);
  }
}

// --- Lingering areas ----------------------------------------------------------
// `combat.zones` (public): an area that stays where it was cast — or follows
// its caster — and catches a creature that starts its turn in it or walks
// into it, once per turn. Catching only notes a due save (`zoneDue`, transient);
// `sweepZones` opens it at the top of the next combat save, where the HP
// transaction and the acting user are known.
function zoneAim(key, zone) {
  if (!zone.follow) return zone.aim;
  const object = ownValue((maps[key] && maps[key].objects) || {}, zone.sourceId);
  if (!object || !object.position) return zone.aim;
  const at = { x: object.position.x, z: object.position.z };
  return { ...zone.aim, origin: at, center: at };
}
function zoneCatch(combat, zone, target) {
  if (zone.touched.includes(target.id) || (zone.follow && target.id === zone.sourceId) || hasEffect(target, 'down')) return;
  zone.touched.push(target.id);
  combat.zoneDue = [...(Array.isArray(combat.zoneDue) ? combat.zoneDue : []), { zone: zone.id, target: target.id }].slice(-40);
}
// A creature's turn begins: every zone forgets who it caught, the caster's
// own zones may run out, and the ones it stands in catch it.
function zonesAtTurnStart(key, combat, c) {
  if (!Array.isArray(combat.zones)) return;
  combat.zones = combat.zones.filter(zone => !(zone.until && zone.sourceId === c.id && combat.round >= zone.until));
  const object = ownValue((maps[key] && maps[key].objects) || {}, c.id);
  for (const zone of combat.zones) {
    zone.touched = [];
    if (zone.on === 'enter' || !object || !object.position) continue;
    if (aoe.inArea(zoneAim(key, zone), object.position.x, object.position.z)) zoneCatch(combat, zone, c);
  }
  if (!combat.zones.length) delete combat.zones;
}
// A creature walked from `from` to `to`: zones it was outside of and crossed.
function zonesOnMove(key, combat, c, from, to) {
  if (!Array.isArray(combat.zones)) return false;
  const before = Array.isArray(combat.zoneDue) ? combat.zoneDue.length : 0;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.5));
  for (const zone of combat.zones) {
    if (zone.on === 'start') continue;
    const aim = zoneAim(key, zone);
    if (aoe.inArea(aim, from.x, from.z)) continue;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      if (aoe.inArea(aim, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) { zoneCatch(combat, zone, c); break; }
    }
  }
  return (Array.isArray(combat.zoneDue) ? combat.zoneDue.length : 0) > before;
}
function sweepZones(key, combat, stagedCharacterHP, rollsNow) {
  if (!combat || !Array.isArray(combat.zoneDue)) return;
  const due = combat.zoneDue;
  delete combat.zoneDue;
  for (const item of due) {
    const zone = (combat.zones || []).find(other => other.id === item.zone);
    const target = ownValue(combat.combatants, item.target);
    if (!zone || !target || hasEffect(target, 'down')) continue;
    openSave(key, combat, { id: zone.sourceId, name: zone.sourceName }, {
      name: zone.name, verb: 'uses', quiet: true, note: ' (lingering)',
      saveAbility: zone.saveAbility, dc: zone.dc, saveSuccess: zone.saveSuccess,
      damage: zone.damage || null, damageType: zone.damageType,
      effect: zone.effect, linked: zone.held === true && !!zone.effect
    }, [target], stagedCharacterHP, (creature) => !creature.owner || rollsNow(creature));
  }
}
function dropZones(combat, keep) {
  if (!Array.isArray(combat.zones)) return;
  combat.zones = combat.zones.filter(keep);
  if (!combat.zones.length) delete combat.zones;
}

// A spell's light or darkness on a token: written here, told to the screens
// once the combat save went through (`flushLightChanges`, connection scope).
const lightChanges = [];
function setSpellLight(key, id, light) {
  const object = ownValue((maps[key] && maps[key].objects) || {}, id);
  if (!object) return false;
  if (light) object.light = light; else delete object.light;
  lightChanges.push({ key, id });
  touchVision();
  return true;
}

// --- Summoned things -----------------------------------------------------------
// Mage Hand, Spiritual Weapon, Dancing Lights...: a `type: 'summon'` object the
// server alone creates (never `add-object`). It belongs to the caster's player
// (`owner`, who may move and dismiss it), stays within `leashFt` of the
// caster's token (`casterId`) and goes with the spell: cast again, concentration
// lost (`held`), its rounds run out (`until`), or its caster leaves the map.
// Changes are told to the screens by `flushSummonChanges` once saved.
const summonChanges = [];
function conjure(key, spec) {
  const map = getMap(key);
  for (const other of Object.values(map.objects)) { // one of each spell per caster
    if (other.type === 'summon' && other.casterId === spec.casterId && other.spell === spec.spell) banish(key, other.id);
  }
  if (Object.keys(map.objects).length >= MAX_MAP_OBJECTS) return null;
  const object = {
    id: crypto.randomUUID(), type: 'summon', kind: spec.kind,
    name: boundedText(spec.spell, 40) || 'Summon', spell: boundedText(spec.spell, 40) || 'Summon',
    position: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
    owner: spec.owner || '', casterId: spec.casterId, casterName: boundedText(spec.casterName, 80) || '',
    leashFt: spec.leashFt || 0, moveFt: spec.moveFt || 0, addedBy: spec.owner || ''
  };
  if (spec.charId) object.charId = spec.charId;
  if (spec.held) object.held = true;
  if (spec.until) object.until = spec.until;
  if (spec.color != null) object.color = spec.color;
  if (spec.castTurn) object.castTurn = spec.castTurn;
  if (isRecord(spec.strike)) object.strike = spec.strike;
  const light = vision.normalizeLight(spec.light);
  if (light) object.light = light;
  map.objects[object.id] = object;
  summonChanges.push({ key, op: 'add', object });
  touchVision();
  return object;
}
function banish(key, id) {
  const map = ownValue(maps, key);
  const object = map && ownValue(map.objects, id);
  if (!object || object.type !== 'summon') return false;
  delete map.objects[id];
  summonChanges.push({ key, op: 'del', object });
  touchVision();
  return true;
}
// Every summon in the campaign that `test` picks. → how many went.
function banishWhere(test, onlyKey = null) {
  let gone = 0;
  for (const key of (onlyKey ? [onlyKey] : Object.keys(maps))) {
    const map = ownValue(maps, key);
    if (!map || !isRecord(map.objects)) continue;
    for (const object of Object.values(map.objects)) {
      if (object && object.type === 'summon' && test(object) && banish(key, object.id)) gone++;
    }
  }
  return gone;
}
function flushSummonChanges() {
  const keys = new Set();
  for (const change of summonChanges.splice(0)) {
    const map = ownValue(maps, change.key);
    if (change.op === 'add') {
      if (map && ownValue(map.objects, change.object.id)) announceObject(change.key, change.object);
    } else {
      forEachMapSocket(change.key, null, (sock) => sock.emit('object-deleted', { id: change.object.id }));
    }
    keys.add(change.key);
  }
  for (const key of keys) reconcileVision(key);
}
// Why a player may not put their summon there (null = fine). In a started
// fight it moves on its caster's turn, `moveFt` a turn (`moved` keeps count).
function summonMoveProblem(key, object, position, commit) {
  const map = getMap(key);
  const caster = ownValue(map.objects, object.casterId);
  const feet = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) * 5;
  if (caster && caster.position && object.leashFt && feet(caster.position, position) > object.leashFt + 2.5) {
    return `${object.name} cannot go more than ${object.leashFt} ft from ${object.casterName || 'its caster'}`;
  }
  const combat = map.combat;
  if (combat && combat.started && hasOwn(combat.combatants, object.casterId)) {
    if (combat.activeId !== object.casterId) return `${object.name} moves on ${object.casterName || 'its caster'}'s turn`;
    const turn = `${combat.round}:${object.casterId}`;
    const used = isRecord(object.moved) && object.moved.turn === turn ? Number(object.moved.feet) || 0 : 0;
    const step = feet(object.position || position, position);
    if (object.moveFt && used + step > object.moveFt + 0.5) {
      return `Too far: ${object.name} moves ${object.moveFt} ft a turn (${Math.max(0, Math.round(object.moveFt - used))} ft left)`;
    }
    if (commit) object.moved = { turn, feet: used + step };
  }
  return null;
}

// --- Concentration -----------------------------------------------------------
// One spell at a time: `c.concentration { name, effects: [{ id, key }], until? }`
// names it and the conditions it holds on others, which end with it. Damage
// asks for a CON save (DC 10, or half the damage if that is higher) that waits
// in `combat.pending` like any other save; dropping to 0 HP, being stunned or
// paralyzed, or turning to another concentration spell ends it outright.
function endConcentration(key, combat, c, why) {
  const held = c.concentration;
  if (!isRecord(held)) return;
  delete c.concentration;
  const freed = new Set();
  for (const link of (Array.isArray(held.effects) ? held.effects : [])) {
    const target = ownValue(combat.combatants, link.id);
    if (!target || !hasEffect(target, link.key)) continue;
    removeEffect(target, link.key);
    freed.add(target.name);
  }
  dropZones(combat, zone => !(zone.held && zone.sourceId === c.id && zone.name === held.name));
  for (const id of (Array.isArray(held.lights) ? held.lights : [])) setSpellLight(key, id, null);
  banishWhere(summon => summon.held === true && summon.casterId === c.id && summon.spell === held.name, key);
  pushLog(key, combat, {
    kind: 'info', actorName: c.name,
    text: `${c.name} ${why} — ${held.name} ends${freed.size ? ` (${[...freed].join(', ')})` : ''}`
  });
}

function beginConcentration(key, combat, c, name, rounds) {
  endConcentration(key, combat, c, 'turns to another spell');
  c.concentration = { name, effects: [] };
  if (rounds > 0 && combat.started) c.concentration.until = combat.round + rounds;
}

function holdEffect(c, target, effectKey) {
  if (isRecord(c.concentration) && c.concentration.effects.length < 24) c.concentration.effects.push({ id: target.id, key: effectKey });
}

// Runs before every combat save: what the damage of this step (`concHits`,
// noted by applyDamageToTarget) and the conditions now in place mean for the
// spells being held. `rollsNow(c)` says whose check the acting user rolls;
// creatures no player owns always roll at once.
function sweepConcentration(key, combat, rollsNow) {
  if (!combat || !isRecord(combat.combatants)) return;
  for (const c of Object.values(combat.combatants)) {
    const hits = Array.isArray(c.concHits) ? c.concHits : [];
    delete c.concHits;
    if (!isRecord(c.concentration)) continue;
    if (hasEffect(c, 'down')) { endConcentration(key, combat, c, 'drops'); continue; }
    if (hasEffect(c, 'stunned') || hasEffect(c, 'paralyzed')) { endConcentration(key, combat, c, 'cannot act'); continue; }
    for (const amount of hits) {
      if (!isRecord(c.concentration)) break;
      const pending = {
        id: crypto.randomUUID().slice(0, 8), sourceId: c.id, sourceName: c.name,
        name: c.concentration.name, verb: 'uses', saveAbility: 'con',
        dc: Math.max(10, Math.floor(amount / 2)), saveSuccess: 'none', damageType: '',
        conc: true, targets: { [c.id]: { done: false } }
      };
      if (!c.owner || rollsNow(c)) resolvePendingSave(key, combat, pending, c, null);
      else combat.pending = [...(Array.isArray(combat.pending) ? combat.pending : []), pending].slice(-12);
    }
  }
  // A check for a spell that has ended meanwhile is owed by no one.
  if (Array.isArray(combat.pending)) {
    combat.pending = combat.pending.filter(pending => !pending.conc ||
      Object.keys(pending.targets).some(id => isRecord((ownValue(combat.combatants, id) || {}).concentration)));
    if (!combat.pending.length) delete combat.pending;
  }
}

// Write a combatant's HP. Characters stage the change so the sheet and every
// tracker mirror stay in one transaction; tokens only live in the tracker.
function setTargetHP(target, next, stagedCharacterHP = null) {
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

// Apply damage to a combatant, mirroring the attack branch's HP write-back exactly.
function applyDamageToTarget(target, amount, stagedCharacterHP = null) {
  const cur = (target.hp && typeof target.hp.current === 'number') ? target.hp.current : target.maxHP;
  if (amount > 0 && isRecord(target.concentration)) target.concHits = [...(target.concHits || []), amount].slice(-8);
  return setTargetHP(target, Math.max(0, cur - amount), stagedCharacterHP);
}

function applyHealToTarget(target, amount, stagedCharacterHP = null) {
  const cur = (target.hp && typeof target.hp.current === 'number') ? target.hp.current : target.maxHP;
  return setTargetHP(target, Math.min(target.maxHP, cur + Math.max(0, amount)), stagedCharacterHP);
}

function fmtSigned(n) { return (n < 0 ? '- ' : '+ ') + Math.abs(n); }

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
    let slotMax = null;
    if (isRecord(value.slotMax)) {
      slotMax = {};
      for (let level = 1; level <= 9; level++) slotMax[level] = clamp(value.slotMax[level], 0, 20, 0);
    }
    const effects = [];
    const seenEffects = new Set();
    for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 32)) {
      const key = isRecord(effect) ? boundedText(effect.key, 24) : '';
      if (!CONDITION_LABELS[key] || seenEffects.has(key)) continue;
      seenEffects.add(key);
      effects.push({ key, label: CONDITION_LABELS[key], auto: effect.auto === true });
    }
    const attacks = normalizeAttacks(value.attacks);
    const spells = normalizeSpells(value.spells);
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
      moveModes: normalizeMoveModes(value.moveModes),
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
      ...(slotMax ? { slotMax } : {}),
      ...(sanitizePact(value.pact) ? { pact: sanitizePact(value.pact) } : {}),
      spells,
      abilities: normalizeAbilities(value.abilities),
      riders: normalizeRiders(value.riders),
      resources: normalizeResources(value.resources),
      saveMods: normalizeSaveMods(value.saveMods),
      ...(normalizeConcentration(value.concentration) ? { concentration: normalizeConcentration(value.concentration) } : {}),
      ...normalizeTurnState(value)
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
  const pending = normalizePending(raw.pending, Object.keys(combatants));
  const zones = normalizeZones(raw.zones, Object.keys(combatants));
  return {
    active: true,
    started: raw.started === true,
    round: raw.started === true ? clamp(raw.round, 1, 1000000, 1) : 0,
    activeId,
    order,
    combatants,
    log,
    ...(pending.length ? { pending } : {}),
    ...(zones.length ? { zones } : {})
  };
}

// Boot normalization: drop/repair malformed persisted combat on every store
// that gets loaded (runs inside withStore for each campaign).
function normalizePersistedCombatState() {
  for (const [key, map] of Object.entries(maps)) {
    if (!hasOwn(map, 'combat')) continue;
    const normalized = normalizePersistedCombat(map.combat);
    if (normalized) map.combat = normalized;
    else {
      console.warn(`[COMBAT] Dropping malformed persisted combat on ${key}.`);
      delete map.combat;
    }
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

// Presentation hint riding on a log entry: who did what to whom, so clients
// can play the matching model animation / breath effect. Ids are the public
// combatant ids (= object ids); nothing here is authoritative.
function combatFx(actor, target, action, damageType, landed) {
  return {
    actor: actor.id,
    ...(target ? { target: target.id } : {}),
    action: boundedString(action, 60),
    ...(damageType ? { type: boundedString(damageType, 20) } : {}),
    ...(landed ? { landed: true } : {})
  };
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
  'actionUsed', 'effects', 'concentration'
];

// Encounter-facing status is shared at the table, but a character's sheet
// choices and stable character id remain private to its owner and the GM.
function projectCombatFor(username, combat) {
  if (!combat || isCampaignGM(username) || !isRecord(combat.combatants)) return combat;
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
      'text', 'roll', 'dmg', 'save', 'fx'
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
    log,
    ...(Array.isArray(combat.pending) && combat.pending.length ? { pending: combat.pending } : {}),
    ...(Array.isArray(combat.zones) && combat.zones.length ? { zones: combat.zones } : {})
  };
}

function emitCombatState(key) {
  const state = (maps[key] && maps[key].combat) || null;
  syncCombatPools(state);
  const pending = state ? (pendingCombatLogs.get(state) || []) : [];
  discardPendingCombatLogs(state);
  for (const queued of pending) {
    if (isUnifiedKey(queued.key)) emitToUnified(null, (sock) => sock.emit('combat-log', queued.entry));
    else io.to(mapRoom(activeCampaignId(), queued.key)).emit('combat-log', queued.entry);
  }
  // The table log keeps what the tracker forgets when the fight ends.
  appendTableLog(pending.filter(queued => queued.entry && queued.entry.text).map(queued => ({
    id: queued.entry.id, ts: queued.entry.ts, kind: 'combat', round: queued.entry.round,
    actor: boundedString(queued.entry.actorName, 80), text: boundedString(queued.entry.text, 600)
  })));
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

// Speeds beyond walking that change what terrain costs (shared/ground.js
// MOVE_MODES): a climb speed takes slopes in stride, a swim speed water.
const MOVE_MODES = ['climb', 'swim', 'fly'];
function normalizeMoveModes(value) {
  return Array.isArray(value) ? MOVE_MODES.filter(mode => value.includes(mode)) : [];
}

function monsterMoveModes(monster) {
  const speed = isRecord(monster && monster.speed) ? monster.speed : {};
  return MOVE_MODES.filter(mode => hasOwn(speed, mode) && /[1-9]\d*\s*ft/i.test(String(speed[mode] || '')));
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
  // Save-or-suffer actions (breath weapons, gazes): no attack roll, a DC and
  // usually damage. A "recharge on roll" usage gates reuse on a d6; the cone
  // or line size is read from the prose.
  const abilities = [];
  for (const action of canonical.actions) {
    if (action.attack_bonus != null || !action.dc) continue;
    const damage = (Array.isArray(action.damage) ? action.damage : []).find(entry => entry && entry.damage_dice);
    const recharge = action.usage ? [null, action.usage.min_value]
      : /\(Recharge (\d)(?:\s*[-–]\s*\d)?\)/i.exec(String(action.name || ''));
    const shape = /(\d+)-foot[- ](cone|line|cube|radius|sphere)/i.exec(String(action.desc || ''));
    // "…centered on a point within 120 feet" is thrown; a bare radius is
    // around the monster itself.
    const far = /point[^.]*within (\d+) feet/i.exec(String(action.desc || ''));
    abilities.push({
      name: String(action.name || 'Ability').replace(/\s*\(Recharge[^)]*\)/i, ''),
      type: 'save', cost: 'action',
      damage: damage ? String(damage.damage_dice).replace(/\s+/g, '') : '',
      damageType: damage ? String(damage.damage_type && (damage.damage_type.index || damage.damage_type.name) || '') : '',
      saveAbility: action.dc.dc_type.index, saveSuccess: action.dc.success_type === 'half' ? 'half' : 'none',
      dc: action.dc.dc_value, maxTargets: 8,
      area: shape ? monsterAreaKind(shape[2], far) : 'cone',
      areaFt: shape ? Number(shape[1]) : 0,
      rangeFt: shape ? (far ? Number(far[1]) : Number(shape[1])) : monsterAttackRange(action, true),
      ...(recharge ? { rechargeOn: Number(recharge[1]) } : {})
    });
  }
  const armor = canonical.armor_class.find(entry => entry && Number.isFinite(Number(entry.value)));
  return {
    canonical,
    ac: boundedScalarInteger(armor && armor.value, 1, 30, 10),
    speedFeet: monsterSpeedFeet(canonical),
    moveModes: monsterMoveModes(canonical),
    initMod: monsterAbilityMod(canonical, 'dexterity'),
    maxHP: boundedScalarInteger(canonical.hit_points, 1, 999, 1),
    saves,
    attacks,
    abilities: normalizeAbilities(abilities)
  };
}

function monsterAreaKind(word, far) {
  const kind = String(word).toLowerCase();
  if (kind === 'radius' || kind === 'sphere') return far ? 'sphere' : 'self';
  return kind;
}

function seedCombatant(obj) {
  const base = {
    id: obj.id, initiative: null,
    movementUsedFeet: 0, dashFeet: 0, actionUsed: false, effects: [],
    moveModes: [],
    saves: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    spellAtk: 0,
    spellDC: 8,
    slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    spells: [],
    abilities: [], riders: [], resources: {}, saveMods: {},
    ...normalizeTurnState(null)
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
        moveModes: monster.moveModes,
        maxHP: monster.maxHP, hp: { current: monster.maxHP },
        saves: monster.saves, attacks: monster.attacks, abilities: monster.abilities
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
  c.bonusUsed = false;
  c.attacksLeft = 0;
  c.bonusAttacks = null;
  c.ridersUsed = [];
  c.effects = (c.effects || []).filter(e => !e.auto);
  for (const resource of Object.values(c.resources || {})) {
    if (resource.recharge === 'turn') resource.current = resource.max;
  }
  pushLog(key, combat, { kind: 'turn', actorName: c.name, text: `Round ${combat.round} — ${c.name}'s turn` });
  if (isRecord(c.concentration) && c.concentration.until && combat.round >= c.concentration.until) {
    endConcentration(key, combat, c, 'runs out of time');
  }
  zonesAtTurnStart(key, combat, c);
  if (banishWhere(summon => summon.casterId === c.id && summon.until && combat.round >= summon.until, key)) {
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name}'s summoned spell runs out of time` });
  }
  // Recharge N: a spent ability comes back when its d6 comes up high enough.
  for (const ability of c.abilities || []) {
    if (!ability.rechargeOn || !ability.spent) continue;
    const die = rollDie(6);
    if (die >= ability.rechargeOn) ability.spent = false;
    pushLog(key, combat, {
      kind: 'info', actorName: c.name,
      text: `${c.name}'s ${ability.name}: recharge d6 ${die} — ${ability.spent ? 'not yet' : 'recharged!'}`
    });
  }
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
  endConcentration(key, combat, combat.combatants[id], 'leaves the fight');
  dropZones(combat, zone => zone.sourceId !== id);
  if (combat.activeId === id) {
    if (combat.order.length > 1) advanceTurn(key, combat);
    else combat.activeId = null;
  }
  delete combat.combatants[id];
  combat.order = combat.order.filter(x => x !== id);
  prunePending(combat); // the saves it owed go with it
}

// Load the default campaign (and run its boot migrations) before any client
// can ask for state.
storeFor(DEFAULT_CAMPAIGN_ID);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  // Campaign membership. On connect the socket sits in the lobby until a
  // login (legacy payloads implicitly enter the default campaign) or an
  // explicit join-campaign picks a world.
  socket.campaignId = null;
  socket.currentMapKey = null;
  socket.contextMapKey = null;
  socket.join('lobby');

  // Run a campaign-scoped event with that campaign's maps/roster bound into
  // the module-level handles. Pre-login sockets fall back to the default
  // store so the handlers' own auth checks answer exactly as before.
  function onCampaign(event, handler) {
    socket.on(event, (payload) => {
      let campaignId = socket.campaignId;
      if (!campaignId && !socket.username) campaignId = DEFAULT_CAMPAIGN_ID;
      if (!campaignId) { socket.emit('error', 'Not in a campaign'); return; }
      const store = storeFor(campaignId);
      if (!store) { socket.emit('error', 'Unknown campaign'); return; }
      withStore(store, () => handler(payload));
    });
  }

  function leaveCampaignRooms(campaignId) {
    if (socket.currentMapKey) socket.leave(mapRoom(campaignId, socket.currentMapKey));
    socket.leave(campRoom(campaignId));
  }

  // Attach this socket to a campaign: rooms, roster, instances and (for the
  // tabletop screens) the first authoritative map-state. `screen: 'studio'`
  // attaches without a map room — the creator only needs the roster.
  function enterCampaign(campaignId, screen, opts = {}) {
    const campaign = campaignById(campaignId);
    // A campaign the user may not enter answers exactly like a missing one.
    if (!campaign || !canEnterCampaign(campaign, socket.username)) {
      socket.emit('campaign-joined', { ok: false, id: campaignId || null, error: 'Unknown campaign' });
      return false;
    }
    if (opts.gmOnly && !isCampaignGMFor(campaignId, socket.username)) {
      socket.emit('campaign-joined', { ok: false, id: campaignId, error: 'GM only' });
      return false;
    }
    const previous = socket.campaignId;
    if (previous) leaveCampaignRooms(previous);
    if (previous !== campaignId) socket.leave('lobby');
    socket.campaignId = campaignId;
    socket.join(campRoom(campaignId));
    const settings = campaign.settings;
    const startKey = settings.mapStyle === 'region' && settings.regionKey
      ? settings.regionKey : DEFAULT_MAP_KEY;
    const startRoom = isTacticalPath(startKey) ? WORLD_KEY : startKey;
    // Emitted before the snapshot so the client can adopt startKey and pass
    // its map-state guard on the very first frame.
    socket.emit('campaign-joined', {
      ok: true,
      id: campaignId,
      name: campaign.name,
      owner: campaign.owner,
      settings,
      startKey,
      ...campaignBrief(campaign),
      visibility: campaign.visibility === 'private' ? 'private' : 'public',
      // The invite list is the GM's business (access dialog on the GM screen).
      ...(isCampaignGMFor(campaignId, socket.username) ? { members: [...campaign.members] } : {})
    });
    const store = storeFor(campaignId);
    if (store) {
      withStore(store, () => {
        if (screen === 'studio') {
          socket.currentMapKey = null;
          socket.contextMapKey = null;
        } else {
          socket.currentMapKey = startRoom;
          socket.contextMapKey = startKey;
          socket.join(mapRoom(campaignId, startRoom));
        }
        socket.emit('load-user-characters', charactersAccessibleTo(socket.username));
        socket.emit('character-instances', { instances: characterInstancesFor(socket.username) });
        if (opts.beforeMapState) opts.beforeMapState();
        if (socket.currentMapKey) sendMapState(socket.currentMapKey, socket.contextMapKey);
      });
    }
    broadcastPresence();
    return true;
  }

  // Login event: { token } (a session from an earlier login) or
  // { username, password } (+ setup: true to create the host account on a
  // fresh install), plus campaignId?/screen? where screen is
  // 'gm'|'player'|'tabletop', 'studio' (creator: roster only) or 'lobby'.
  // Open-login mode also accepts a legacy plain username string, which
  // implicitly enters the default campaign.
  socket.on('login', (payload) => {
    const credentials = typeof payload === 'string' ? { username: payload } : payload;
    const address = socket.handshake.address;
    const result = auth.login(credentials, { ip: address, loopback: isLoopbackAddress(address) });
    if (!result.ok) {
      socket.emit('login-failed', { error: result.error, expired: !!result.expired });
      return;
    }

    socket.username = result.username;
    console.log(`[LOGIN] ${socket.username} (${socket.id})`);

    // Send login success with role (isGM = the host account).
    socket.emit('login-success', {
      username: socket.username,
      isGM: isGM(socket.username),
      token: result.token
    });

    // Races/classes are shared content; monster rules are GM/author scoped.
    const sendHomebrew = () => socket.emit('load-homebrew', homebrewPayloadFor(socket.username));

    const options = isRecord(payload) ? payload : {};
    if (options.screen === 'lobby') {
      if (socket.campaignId) { leaveCampaignRooms(socket.campaignId); socket.campaignId = null; }
      socket.join('lobby');
      sendHomebrew();
      pushCampaignList();
      pushUserList();
      return;
    }
    // An explicit campaign must be enterable; only a bare login (homebrew,
    // legacy clients) falls back to the default campaign.
    const requested = boundedString(options.campaignId, 40);
    const fallback = campaignById(DEFAULT_CAMPAIGN_ID);
    const targetId = requested ||
      (fallback && canEnterCampaign(fallback, socket.username) ? DEFAULT_CAMPAIGN_ID : null);
    if (!targetId) {
      sendHomebrew();
      socket.emit('campaign-joined', { ok: false, error: 'No campaign available' });
      return;
    }
    if (!enterCampaign(targetId, options.screen === 'studio' ? 'studio' : 'tabletop',
      { beforeMapState: sendHomebrew, gmOnly: options.screen === 'gm' })) sendHomebrew();
  });

  // --- Campaign registry (lobby) ---
  socket.on('get-campaigns', () => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    socket.emit('campaign-list', { campaigns: campaignsPayload(socket.username) });
  });

  socket.on('create-campaign', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const name = boundedText(payload && payload.name, MAX_CAMPAIGN_NAME);
    if (!name) { socket.emit('error', 'Campaign name required'); return; }
    if (Object.keys(campaigns).length >= MAX_CAMPAIGNS) {
      socket.emit('error', `Campaign limit reached (${MAX_CAMPAIGNS})`);
      return;
    }
    // Untrusted users file a request: the campaign is saved but stays locked
    // ('pending') until the host approves it.
    const pending = !auth.isTrusted(socket.username);
    if (pending) {
      const waiting = Object.values(campaigns).filter(c =>
        c.status === 'pending' && sameUser(c.owner, socket.username)).length;
      if (waiting >= MAX_PENDING_CAMPAIGNS_PER_USER) {
        socket.emit('error', 'You already have campaign requests waiting for the host');
        return;
      }
    }
    const id = crypto.randomUUID().slice(0, 8);
    const campaign = {
      id,
      name,
      description: boundedText(payload.description, MAX_CAMPAIGN_DESCRIPTION),
      owner: socket.username,
      createdAt: Date.now(),
      settings: sanitizeCampaignSettings(payload.settings),
      visibility: payload.visibility === 'private' ? 'private' : 'public',
      members: [],
      status: pending ? 'pending' : 'active'
    };
    campaigns[id] = campaign;
    if (!saveCampaigns()) {
      delete campaigns[id];
      socket.emit('error', 'Could not save the campaign');
      return;
    }
    console.log(`[CAMPAIGN] "${campaign.name}" (${id}) ${pending ? 'requested' : 'created'} by ${socket.username}`);
    socket.emit('campaign-created', { id, pending });
    pushCampaignList();
  });

  // Host verdict on a pending campaign request.
  socket.on('review-campaign', (payload) => {
    if (!isGM(socket.username)) { socket.emit('error', 'Host only'); return; }
    const id = boundedString(payload && payload.id, 40);
    const campaign = campaignById(id);
    if (!campaign || campaign.status !== 'pending') { socket.emit('error', 'No such request'); return; }
    if (payload.approve === true) {
      campaign.status = 'active';
      if (!saveCampaigns()) {
        campaign.status = 'pending';
        socket.emit('error', 'Could not save the campaign');
        return;
      }
      console.log(`[CAMPAIGN] "${campaign.name}" (${id}) approved by ${socket.username}`);
    } else {
      if (!destroyCampaign(id)) { socket.emit('error', 'Could not delete the campaign'); return; }
      console.log(`[CAMPAIGN] "${campaign.name}" (${id}) rejected by ${socket.username}`);
    }
    pushCampaignList();
  });

  // Privacy + invites, set by the campaign GM: { id, visibility?, members? }
  // (members replaces the whole invite list; unknown accounts are dropped).
  socket.on('set-campaign-access', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = boundedString(payload && payload.id, 40);
    const campaign = campaignById(id);
    if (!campaign) { socket.emit('error', 'Unknown campaign'); return; }
    if (!isCampaignGMFor(id, socket.username)) { socket.emit('error', 'GM only'); return; }
    const previous = { visibility: campaign.visibility, members: campaign.members };
    if (payload.visibility === 'public' || payload.visibility === 'private') {
      campaign.visibility = payload.visibility;
    }
    if (Array.isArray(payload.members)) {
      campaign.members = sanitizeCampaignMembers(
        payload.members.map(name => auth.canonical(name)).filter(Boolean)
      ).filter(name => !sameUser(name, campaign.owner));
    }
    if (!saveCampaigns()) {
      Object.assign(campaign, previous);
      socket.emit('error', 'Could not save the campaign access');
      return;
    }
    // Anyone seated who just lost access goes back to the lobby.
    evictFromCampaign(id, sock => !canEnterCampaign(campaign, sock.username));
    // The answer carries the saved state so the open dialog's caller can
    // refresh without a full campaign-list refetch (only the GM receives it).
    socket.emit('campaign-access-saved', {
      id,
      visibility: campaign.visibility,
      members: [...campaign.members]
    });
    pushCampaignList();
  });

  // Export one campaign as a JSON bundle the GM downloads: the registry record,
  // characters, journal (notes/treasury/XP), pools and rests, the table log,
  // chat, bookmarks, encounters and every map's state — the same store files,
  // grouped in one file.
  socket.on('export-campaign', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = boundedString(payload && payload.id, 40);
    const campaign = campaignById(id);
    if (!campaign) { socket.emit('error', 'Unknown campaign'); return; }
    if (!isCampaignGMFor(id, socket.username)) { socket.emit('error', 'GM only'); return; }
    const store = storeFor(id);
    if (!store) { socket.emit('error', 'Unknown campaign'); return; }
    const data = withStore(store, () => ({
      format: '3dx-campaign',
      version: 1,
      exportedAt: new Date().toISOString(),
      campaign: structuredClone(campaign),
      characters: structuredClone(charactersDB),
      journal: structuredClone(journalDB()),
      pools: { chars: structuredClone(poolsDB()), requests: structuredClone(restList()) },
      rolls: structuredClone(tableLog()),
      chat: structuredClone(chatDB()),
      bookmarks: structuredClone(bookmarksDB()),
      encounters: structuredClone(encountersDB()),
      maps: structuredClone(maps)
    }));
    console.log(`[CAMPAIGN] ${socket.username} exported "${campaign.name}" (${id})`);
    socket.emit('campaign-export', { id, name: campaign.name, data });
  });

  // --- Accounts (host tab) ---
  socket.on('get-users', () => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    socket.emit('user-list', { users: usersPayload(socket.username) });
  });

  socket.on('admin-create-user', (payload) => {
    if (!isGM(socket.username)) { socket.emit('error', 'Host only'); return; }
    const result = auth.createUser(isRecord(payload) ? payload : {});
    if (!result.ok) { socket.emit('error', result.error); return; }
    console.log(`[AUTH] ${result.username} created by ${socket.username}`);
    socket.emit('admin-done', { action: 'create', username: result.username });
    pushUserList();
  });

  // { username, trusted?, disabled?, password? } — users never change their
  // own password; a new one only ever comes from the host.
  socket.on('admin-update-user', (payload) => {
    if (!isGM(socket.username)) { socket.emit('error', 'Host only'); return; }
    const source = isRecord(payload) ? payload : {};
    const result = auth.updateUser(source.username, source);
    if (!result.ok) { socket.emit('error', result.error); return; }
    console.log(`[AUTH] ${result.username} updated by ${socket.username}`);
    if (result.revoked) {
      for (const sock of io.sockets.sockets.values()) {
        if (sock === socket || !sameUser(sock.username, result.username)) continue;
        sock.emit('login-failed', { error: 'Your session was ended by the host', expired: true });
        sock.disconnect(true);
      }
    }
    socket.emit('admin-done', { action: 'update', username: result.username });
    pushUserList();
    pushCampaignList();
  });

  socket.on('join-campaign', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = boundedString(payload && payload.id, 40);
    enterCampaign(id, payload && payload.screen === 'studio' ? 'studio' : 'tabletop');
  });

  socket.on('leave-campaign', () => {
    if (socket.campaignId) leaveCampaignRooms(socket.campaignId);
    socket.campaignId = null;
    socket.currentMapKey = null;
    socket.contextMapKey = null;
    socket.join('lobby');
    socket.emit('campaign-left', {});
    broadcastPresence();
  });

  // Worldbuilding settings: an allow-listed patch applied by the campaign GM.
  // The region key is always re-derived from the spawn, never trusted.
  socket.on('update-campaign-settings', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = boundedString(payload && payload.id, 40);
    const campaign = campaignById(id);
    if (!campaign) { socket.emit('error', 'Unknown campaign'); return; }
    if (!isCampaignGMFor(id, socket.username)) { socket.emit('error', 'GM only'); return; }
    const requested = isRecord(payload.settings) ? payload.settings : {};
    const merged = {
      mapStyle: campaign.settings.mapStyle,
      seed: requested.seed !== undefined ? requested.seed : campaign.settings.seed,
      // An empty palette is "not specified", not "no biomes" — sanitize would
      // expand it to every default anyway, so keep the existing palette explicit.
      biomes: (Array.isArray(requested.biomes) && requested.biomes.length)
        ? requested.biomes
        : campaign.settings.biomes,
      spawn: requested.spawn !== undefined ? requested.spawn : campaign.settings.spawn,
      world: requested.world !== undefined ? requested.world : campaign.settings.world,
      season: requested.season !== undefined ? requested.season : campaign.settings.season,
      sky: campaign.settings.sky,
      // A vision patch, like the sky: untouched keys keep their value.
      vision: isRecord(requested.vision)
        ? { ...campaign.settings.vision, ...requested.vision }
        : campaign.settings.vision,
      movement: isRecord(requested.movement)
        ? { ...campaign.settings.movement, ...requested.movement }
        : campaign.settings.movement,
      regionKey: campaign.settings.regionKey
    };
    if (isRecord(requested.sky)) {
      // A sky patch: untouched keys keep their value, and setting the clock
      // restamps it so every screen counts the hours from the same instant.
      const { at, ...patch } = requested.sky;
      merged.sky = { ...campaign.settings.sky, ...patch };
      if (['clock', 'hour', 'dayMinutes'].some(key => patch[key] !== undefined)) merged.sky.at = Date.now();
    }
    const previous = snapshotField(campaign, 'settings');
    campaign.settings = sanitizeCampaignSettings(merged);
    // Identity + hall fields ride at the top level of the payload (the GM
    // panel sends them there); `settings.name` is the older spelling.
    const identity = {
      name: campaign.name, description: campaign.description, recap: campaign.recap,
      session: campaign.session, sessions: campaign.sessions
    };
    const field = key => (payload[key] != null ? payload[key] : requested[key]);
    if (field('name') != null) campaign.name = boundedText(field('name'), MAX_CAMPAIGN_NAME) || campaign.name;
    if (field('description') != null) campaign.description = boundedText(field('description'), MAX_CAMPAIGN_DESCRIPTION);
    // "Post new session" archives the recap into the history; a plain recap
    // save (no postSession) only rewrites the current "last time" text.
    if (payload.postSession === true) {
      const text = boundedMultilineText(payload.recap, MAX_CAMPAIGN_RECAP);
      if (text) {
        const sessions = [...(campaign.sessions || [])];
        const n = sessions.length ? sessions[sessions.length - 1].n + 1 : 1;
        sessions.push({ n, at: Date.now(), text });
        while (sessions.length > MAX_CAMPAIGN_SESSIONS) sessions.shift();
        campaign.sessions = sessions;
        campaign.recap = text;
      }
    } else if (payload.recap != null) {
      campaign.recap = boundedMultilineText(payload.recap, MAX_CAMPAIGN_RECAP);
    }
    if (payload.deleteSession != null) {
      const n = boundedInteger(payload.deleteSession, 1, 100000, null);
      if (n != null && Array.isArray(campaign.sessions)) {
        campaign.sessions = campaign.sessions.filter(entry => entry.n !== n);
        // The hall's "last time" always shows the newest archive.
        campaign.recap = campaign.sessions.length
          ? campaign.sessions[campaign.sessions.length - 1].text : '';
      }
    }
    if (payload.session === 'open' || payload.session === 'closed') campaign.session = payload.session;
    if (!saveCampaigns()) {
      restoreField(campaign, 'settings', previous);
      Object.assign(campaign, identity);
      socket.emit('error', 'Could not save the campaign settings');
      return;
    }
    const settings = campaign.settings;
    io.to(campRoom(id)).emit('campaign-updated', {
      id, name: campaign.name, settings, ...campaignBrief(campaign)
    });
    // Vision rules or the hour of day may have changed who sees whom.
    const store = storeFor(id);
    if (store) withStore(store, () => reconcileCampaignVision());
    pushCampaignList();
  });

  socket.on('delete-campaign', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = boundedString(payload && payload.id, 40);
    if (id === DEFAULT_CAMPAIGN_ID) { socket.emit('error', 'The default campaign cannot be deleted'); return; }
    const campaign = campaignById(id);
    if (!campaign) { socket.emit('error', 'Unknown campaign'); return; }
    if (!isCampaignGMFor(id, socket.username)) { socket.emit('error', 'GM only'); return; }
    // Everyone inside is kicked back to the lobby; a requester sitting in the
    // lobby (or another campaign) still needs the ack.
    const requesterInside = socket.campaignId === id;
    if (!destroyCampaign(id)) {
      socket.emit('error', 'Could not delete the campaign');
      return;
    }
    console.log(`[CAMPAIGN] "${campaign.name}" (${id}) deleted by ${socket.username}`);
    if (!requesterInside) socket.emit('campaign-deleted', { id });
    pushCampaignList();
  });

  // Deep-copy a character from one campaign into another (the wizard's party
  // step runs from the lobby, so the target is explicit; omitted = the acting
  // campaign). New id, same owner, sheet and HP copied.
  socket.on('copy-character', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const fromCampaignId = boundedString(payload && payload.fromCampaignId, 40);
    const charId = boundedText(payload && payload.charId, 80);
    if (!fromCampaignId || !charId) { socket.emit('error', 'Invalid copy request'); return; }
    const toCampaignId = boundedString(payload && payload.toCampaignId, 40) || socket.campaignId;
    if (!toCampaignId || !campaignById(toCampaignId)) {
      socket.emit('error', 'No target campaign');
      return;
    }
    const sourceStore = storeFor(fromCampaignId);
    const sourceChar = sourceStore && ownValue(sourceStore.characters, charId);
    if (!sourceChar) { socket.emit('error', 'Character not found'); return; }
    const allowedSource = sourceChar.owner === socket.username ||
      isCampaignGMFor(fromCampaignId, socket.username) ||
      isGM(socket.username);
    // Writing into another campaign needs authority over the target too
    // (same-campaign copies are already the source check): its GM, or a
    // player bringing their own character to a table they may enter.
    const allowedTarget = toCampaignId === fromCampaignId ||
      isCampaignGMFor(toCampaignId, socket.username) ||
      isGM(socket.username) ||
      (sourceChar.owner === socket.username &&
        canEnterCampaign(campaignById(toCampaignId), socket.username));
    if (!allowedSource || !allowedTarget) { socket.emit('error', 'Permission denied'); return; }
    const targetStore = storeFor(toCampaignId);
    if (!targetStore) { socket.emit('error', 'Unknown campaign'); return; }
    withStore(targetStore, () => {
      const owner = sourceChar.owner;
      const ownerCount = Object.values(charactersDB).filter(char => char.owner === owner).length;
      if (ownerCount >= MAX_CHARACTERS_PER_OWNER) {
        socket.emit('error', `Character limit reached (${MAX_CHARACTERS_PER_OWNER} per user)`);
        return;
      }
      const copy = cloneJSON(sourceChar);
      delete copy.id;
      const charData = sanitizeCharacterPayload(copy);
      if (!charData) { socket.emit('error', 'Invalid character'); return; }
      charData.id = crypto.randomUUID();
      charData.owner = owner;
      const previousCharacter = snapshotField(charactersDB, charData.id);
      charactersDB[charData.id] = charData;
      if (!saveJSON('characters.json', charactersDB)) {
        restoreField(charactersDB, charData.id, previousCharacter);
        socket.emit('error', 'Could not copy the character');
        return;
      }
      console.log(`[COPY] ${sourceChar.name} (${fromCampaignId} -> ${toCampaignId}) for ${socket.username}`);
      socket.emit('character-saved-success', charData);
      socket.emit('load-user-characters', charactersAccessibleTo(socket.username));
      emitCharacterChange('character-updated', charData, charData.owner);
    });
  });

  // Get characters (filtered by permission)
  onCampaign('get-characters', () => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    socket.emit('load-user-characters', charactersAccessibleTo(socket.username));
  });

  // Save character
  onCampaign('save-character', (payload) => {
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
  onCampaign('delete-character', (payload) => {
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
  onCampaign('update-hp', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = isRecord(payload) ? sanitizeReference(payload.id, 80) : null;
    const char = id && ownValue(charactersDB, id);
    if (!char) { socket.emit('error', 'Character not found'); return; }
    if (!canAccessCharacter(socket.username, char)) { socket.emit('error', 'Permission denied'); return; }
    const nextHP = boundedScalarInteger(payload.current, 0, 999, null);
    if (nextHP == null) { socket.emit('error', 'Invalid HP'); return; }
    const pool = hasOwn(poolsDB(), id) ? poolsDB()[id] : null;
    const had = char.hp && Number.isFinite(char.hp.current) ? char.hp.current : (pool && pool.vit ? pool.vit.maxHP : null);
    if (applyCharacterHP(id, nextHP) == null) {
      socket.emit('error', 'Could not update character HP');
      return;
    }
    // Hurt while holding a spell outside a fight: the sheet owes a CON save
    // (the tracker asks for it itself inside one).
    if (pool && pool.conc && had != null && nextHP < had && !combatantsOfCharacter(id).length) {
      const name = char.name || 'A character';
      if (nextHP === 0) {
        appendTableLog([{
          id: crypto.randomUUID().slice(0, 8), ts: Date.now(), kind: 'roll', user: socket.username, gm: isCampaignGM(socket.username),
          actor: name, label: `drops — ${pool.conc.name} ends`, text: `${name} drops — ${pool.conc.name} ends`
        }]);
        delete pool.conc;
        if (banishWhere(summon => summon.held === true && summon.charId === id)) { saveMaps(); flushSummonChanges(); }
      } else {
        pool.conc.dc = Math.max(pool.conc.dc || 0, 10, Math.floor((had - nextHP) / 2));
      }
      savePools([id]);
    }
  });

  // Let go of a spell held outside a fight (in one: combat-concentration).
  onCampaign('drop-concentration', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return combatDeny('Not your character');
    if (combatantsOfCharacter(charId).length) return combatDeny('In a fight, drop it from the combat tracker');
    const pool = hasOwn(poolsDB(), charId) ? poolsDB()[charId] : null;
    if (!pool || !pool.conc) return;
    const name = character.name || 'A character';
    appendTableLog([{
      id: crypto.randomUUID().slice(0, 8), ts: Date.now(), kind: 'roll', user: socket.username, gm: isCampaignGM(socket.username),
      actor: name, label: `stops concentrating — ${pool.conc.name} ends`, text: `${name} stops concentrating — ${pool.conc.name} ends`
    }]);
    delete pool.conc;
    if (banishWhere(summon => summon.held === true && summon.charId === charId)) { saveMaps(); flushSummonChanges(); }
    savePools([charId]);
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
    const store = hasOwn(HOMEBREW_COLLECTIONS, type) ? homebrewDB[HOMEBREW_COLLECTIONS[type]] : null;
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
    const store = hasOwn(HOMEBREW_COLLECTIONS, type) ? homebrewDB[HOMEBREW_COLLECTIONS[type]] : null;
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

  // The ground a move in this room crosses, as shared/ground.js reads it —
  // the stored chunk edits over the campaign's generator (pockets: edits over
  // flat ground). Null when the campaign prices no terrain.
  function movementGround(key) {
    const campaign = activeCampaign();
    const settings = campaign && campaign.settings;
    if (!settings || !groundModel) return null;
    const rules = groundModel.normalizeMovement(settings.movement);
    if (!rules.terrain) return null;
    const unified = key === WORLD_KEY;
    const map = ownValue(maps, key);
    const terrain = map && isRecord(map.terrain) && map.terrain.format === 2 ? map.terrain : null;
    return {
      rules,
      ground: groundModel.createGround({
        seed: settings.seed, world: settings.world, season: settings.season,
        hexTree: unified ? collectHexTree() : null,
        chunks: terrain && isRecord(terrain.chunks) ? terrain.chunks : null,
        water: terrain && isRecord(terrain.water) ? terrain.water : null,
        generator: unified
      })
    };
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
    const m = isCampaignGM(socket.username) ? getMap(roomKey) : mapForRead(roomKey);
    const ctx = contextKey || roomKey;
    const extra = {};
    const gm = isCampaignGM(socket.username);
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
    if (!gm) {
      const objectKey = stateKey(roomKey);
      objectsOut = objectsOut.filter(o => objectVisibleTo(socket.username, o, objectKey));
      if (unified) terrainOut = filterTerrainForPlayer(terrainOut);
    }
    socket.visionShown = new Set(objectsOut.filter(vision.isCreature).map(o => o.id));
    objectsOut = objectsOut.map(object => projectObjectFor(socket.username, object));
    socket.emit('map-state', {
      key: ctx,
      // The campaign stamp lets the client adopt settings/startKey even when
      // it never saw campaign-joined (late loads, room re-joins).
      campaign: (() => {
        const c = activeCampaign();
        return c ? { id: c.id, name: c.name, owner: c.owner, settings: c.settings } : null;
      })(),
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

  // No room is joined until a campaign is entered (login / join-campaign);
  // transport connect parks the socket in the lobby.

  // Switch this socket to a different map. Tactical paths are routed to the one
  // continuous world (WORLD_KEY) so provinces share terrain; hex tiers and
  // pockets keep their own rooms.
  onCampaign('join-map', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const requestedKey = payload && payload.key != null ? payload.key : DEFAULT_MAP_KEY;
    const reqKey = knownMapKey(requestedKey);
    if (!reqKey) { socket.emit('error', 'Unknown map'); return; }
    const roomKey = isTacticalPath(reqKey) ? WORLD_KEY : reqKey;
    // Region-style campaigns expose one province lens (plus the pockets and
    // tactical store beneath it); continent/kingdom/other-province lenses and
    // legacy stores are out of bounds.
    const settings = campaignSettings();
    if (settings.mapStyle === 'region' && settings.regionKey) {
      const underRegion = reqKey === settings.regionKey ||
        reqKey.startsWith(settings.regionKey + '/');
      const allowed = underRegion ||
        reqKey.startsWith('pocket/') ||
        reqKey === WORLD_KEY;
      if (!allowed) { socket.emit('error', 'Unknown map'); return; }
    }
    const campaignId = activeCampaignId();
    if (socket.currentMapKey && socket.currentMapKey !== roomKey) {
      socket.leave(mapRoom(campaignId, socket.currentMapKey));
    }
    socket.currentMapKey = roomKey;
    socket.contextMapKey = reqKey;
    socket.join(mapRoom(campaignId, roomKey));
    if (isCampaignGM(socket.username) || hasOwn(maps, roomKey)) getMap(roomKey);
    if (roomKey === WORLD_KEY) ensureWorld();
    console.log(`[MAP] ${socket.username || socket.id} -> ${reqKey}${roomKey !== reqKey ? ' [' + roomKey + ']' : ''}`);
    sendMapState(roomKey, reqKey);
    if (socket.username) broadcastPresence();
  });

  // Tag a hex on the current (hex-layer) map with a biome; null clears the tag.
  // Tags color the hex on the GM screen and seed new tactical maps beneath it.
  onCampaign('update-hex', (payload) => {
    if (!isCampaignGM(socket.username)) { socket.emit('error', 'GM only'); return; }
    const q = Math.round(Number(payload && payload.q)), r = Math.round(Number(payload && payload.r));
    if (!isFinite(q) || !isFinite(r) || Math.abs(q) > 64 || Math.abs(r) > 64) return;
    const biome = payload.biome == null ? null : String(payload.biome);
    if (biome !== null && !BIOME_KEYS.includes(biome)) return;
    // The campaign's palette (settings.biomes) decides which tags the GM may
    // paint; unknown keys stay silently ignored, out-of-palette ones answer.
    if (biome !== null && !(campaignSettings().biomes || BIOME_KEYS).includes(biome)) {
      socket.emit('error', 'Biome is not in this campaign palette');
      return;
    }
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
    io.to(campRoom(activeCampaignId())).emit('hex-updated', { key, hex: hk, biome });
  });

  // Create a pocket map (dungeon/cave/room): its own map key outside the hex tree,
  // entered through portal objects. Ships with an exit portal back to the parent.
  onCampaign('create-pocket-map', (payload) => {
    if (!isCampaignGM(socket.username)) { socket.emit('error', 'GM only'); return; }
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
    pushDungeons();
  });

  onCampaign('get-dungeons', () => {
    if (!isCampaignGM(socket.username)) return;
    socket.emit('dungeon-list', { dungeons: dungeonIndex() });
  });

  onCampaign('add-object', (data) => {
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
    // Fog of war and token vision: only players who can see it learn the
    // object exists. A new token, wall or light can also change what the
    // others see.
    touchVision();
    announceObject(key, newObject);
    reconcileVision(key);
    if (newObject.type === 'character') pushCharacterInstances();
    if (newObject.type === 'portal') pushDungeons();
    if (combatChanged) emitCombatState(key);
  });

  // Atomic whole-building operations. The client names a stable building and
  // supplies the exact source ids it observed; the server re-derives that set,
  // transforms every piece, persists once, then sends one canonical result.
  onCampaign('structure-batch', (payload) => {
    const requestId = sanitizeStructureIdentity(payload && payload.requestId);
    const reject = (reason) => socket.emit('structure-batch-rejected', { requestId, reason });
    if (!isCampaignGM(socket.username)) { reject('GM only'); return; }
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
        if (key === WORLD_KEY && !isCampaignGM(recipient.username)) {
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
      reconcileVision(key);
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
  onCampaign('get-character-instances', () => {
    if (!socket.username) return;
    socket.emit('character-instances', { instances: characterInstancesFor(socket.username) });
  });

  // Party view: the campaign's roster as identity ONLY — name, owner, race and
  // the class/level line. No HP, AC, conditions or anything mechanical: other
  // players' numbers stay hidden (the GM already sees them in combat).
  onCampaign('get-party', () => {
    if (!socket.username) return;
    const members = Object.values(charactersDB).map((char) => {
      const classes = Array.isArray(char.classes) ? char.classes : [];
      const level = classes.reduce((sum, c) => sum + (Number(c && c.level) || 0), 0);
      return {
        id: String(char.id || ''),
        name: String(char.name || 'Unnamed').slice(0, 120),
        owner: String(char.owner || ''),
        race: String(char.race || ''),
        cls: String((classes[0] && (classes[0].class || classes[0].name)) || ''),
        level
      };
    }).filter(entry => entry.id);
    socket.emit('party', { members });
  });

  // Remove a character token from the Instances tab. Unlike delete-object,
  // this accepts the token's map key so it can remove a token without first
  // navigating to that map. Players may remove only their own tokens; the GM
  // may remove any character token.
  onCampaign('delete-character-instance', (payload) => {
    if (!socket.username || !payload || !payload.id) return;
    const requestedKey = knownMapKey(payload.mapKey != null ? payload.mapKey : (socket.currentMapKey || DEFAULT_MAP_KEY));
    if (!requestedKey) return;
    const key = stateKey(requestedKey);
    const map = maps[key];
    if (!map) return;
    const id = boundedText(payload.id, 80);
    const obj = ownValue(map.objects, id);
    if (!obj || obj.type !== 'character' || (!isCampaignGM(socket.username) && !ownsObject(socket.username, obj))) {
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
    else io.to(mapRoom(activeCampaignId(), key)).emit('object-deleted', event);
    reconcileVision(key);
    pushCharacterInstances();
    if (combatChanged) emitCombatState(key);
  });

  // Context-inspector presentation edits plus the build tool's bounded,
  // per-cell wall-opening and floor/roof tile geometry patches.
  onCampaign('update-object', (payload) => {
    if (!isCampaignGM(socket.username)) return;
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
        // A cell that stops being a door drops its open/locked state.
        if (Array.isArray(obj.doors)) patch.doors = sanitizeWallDoors({ segments: patch.segments }, obj.doors);
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
    if (patch.doors === null) delete obj.doors;
    emitObjectUpdated(key, obj, patch);
    reconcileVision(key);
    if (combatant) emitCombatState(key);
  });

  // An object patch goes to whoever currently has the object.
  function emitObjectUpdated(key, obj, patch) {
    const event = { id: obj.id, patch };
    forEachMapSocket(key, null, (sock) => {
      const has = vision.isCreature(obj) && !isCampaignGM(sock.username) && !ownsObject(sock.username, obj)
        ? shownSet(sock).has(obj.id)
        : objectVisibleTo(sock.username, obj, key);
      if (has) sock.emit('object-updated', event);
    });
  }

  // Vision data on a map object: `senses` (a creature's darkvision,
  // blindsight, truesight, tremorsense, Devil's Sight — the owner's screen
  // sends what the sheet derives; null goes back to the stat block), `light`
  // (bright/dim radii in feet, or a magical-darkness radius) and the GM's
  // `hidden` (GM eyes only) / `invisible` (needs a sense that beats it).
  onCampaign('set-vision', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = boundedText(payload.id, 80);
    const obj = id && ownValue(map.objects, id);
    if (!obj) return;
    const gm = isCampaignGM(socket.username);
    if (!gm && !ownsObject(socket.username, obj)) return;
    const creature = vision.isCreature(obj);
    const patch = {};
    if (creature && hasOwn(payload, 'senses')) {
      patch.senses = isRecord(payload.senses) ? vision.normalizeSenses(payload.senses) : null;
    }
    if (hasOwn(payload, 'light')) patch.light = vision.normalizeLight(payload.light);
    if (gm && creature && typeof payload.invisible === 'boolean') patch.invisible = payload.invisible;
    if (gm && typeof payload.hidden === 'boolean') patch.hidden = payload.hidden;
    for (const field of Object.keys(patch)) {
      if (JSON.stringify(patch[field] || null) === JSON.stringify(obj[field] || null)) delete patch[field];
    }
    if (!Object.keys(patch).length) return;
    const previousObject = structuredClone(obj);
    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === false) delete obj[field];
      else obj[field] = value;
    }
    if (!saveMaps()) {
      map.objects[id] = previousObject;
      socket.emit('error', 'Could not save the vision update');
      return;
    }
    touchVision();
    const hiddenChanged = hasOwn(patch, 'hidden');
    forEachMapSocket(key, null, (sock) => {
      if (isCampaignGM(sock.username) || ownsObject(sock.username, obj)) {
        sock.emit('object-updated', { id, patch });
      } else if (creature) {
        // Appearing and vanishing is reconcileVision's job, just below.
        if (shownSet(sock).has(id) && obj.hidden !== true) sock.emit('object-updated', { id, patch });
      } else if (hiddenChanged) {
        if (obj.hidden === true) sock.emit('object-deleted', { id });
        else if (objectVisibleTo(sock.username, obj, key)) sock.emit('object-added', projectObjectFor(sock.username, obj));
      } else if (objectVisibleTo(sock.username, obj, key)) {
        sock.emit('object-updated', { id, patch });
      }
    });
    reconcileVision(key);
  });

  // Open or close a door cell. The GM may also lock it (`state: 'locked'`) or
  // set any state outright; a player needs one of their own characters
  // standing at the door, and a locked door stays shut for them.
  onCampaign('toggle-door', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = boundedText(payload.id, 80);
    const wall = id && ownValue(map.objects, id);
    if (!wall || wall.type !== 'wall' || !Array.isArray(wall.segments) || !wall.position) return;
    const index = Math.round(Number(payload.index));
    if (!Number.isInteger(index) || index < 0 || index >= WALL_CELL_LIMIT) return;
    if (wall.segments[index] !== 'door') return;
    const gm = isCampaignGM(socket.username);
    const current = vision.doorStateOf(wall, index);
    let next;
    if (gm && hasOwn(payload, 'state')) {
      next = vision.DOOR_STATES.includes(payload.state) ? payload.state : null;
    } else {
      if (!gm) {
        const cell = vision.wallCellsOf(wall)[index];
        if (!cell) return;
        const cx = wall.position.x + cell.x + cell.ux * 0.5, cz = wall.position.z + cell.z + cell.uz * 0.5;
        const reach = Object.values(map.objects).some(o => ownsObject(socket.username, o) && o.position &&
          Math.hypot(o.position.x - cx, o.position.z - cz) <= 2.1 &&
          Math.abs(o.position.y - wall.position.y) <= 3);
        if (!reach) { socket.emit('combat-denied', { reason: 'Move a character next to the door first' }); return; }
        if (current === 'locked') { socket.emit('combat-denied', { reason: 'The door is locked' }); return; }
      }
      next = current === 'open' ? null : 'open';
    }
    if (next === current) return;
    const previousDoors = snapshotField(wall, 'doors');
    const doors = Array.from({ length: wall.segments.length }, (_, i) => vision.doorStateOf(wall, i));
    doors[index] = next;
    const clean = sanitizeWallDoors(wall, doors);
    if (clean) wall.doors = clean; else delete wall.doors;
    if (!saveMaps()) {
      restoreField(wall, 'doors', previousDoors);
      socket.emit('error', 'Could not save the door');
      return;
    }
    emitObjectUpdated(key, wall, { doors: clean });
    reconcileVision(key);
  });

  onCampaign('move-object', (data) => {
    if (!socket.username || !isRecord(data)) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = boundedText(data.id, 80);
    const position = sanitizePosition(data.position);
    const controlledObject = id && ownValue(map.objects, id);
    if (!id || !position || !controlledObject) return;
    // Players manipulate only their own character instances. The GM remains
    // authoritative for generic tokens, creatures, props and structures.
    if (!isCampaignGM(socket.username) && !ownsObject(socket.username, controlledObject)) {
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
    // Walls, shut doors and bars stop a player's character (shared/passage.js):
    // the way has to be open, straight or round a corner. The GM puts tokens
    // wherever the story needs them.
    let walk = null;
    if (!isCampaignGM(socket.username) && vision.isCreature(controlledObject) && controlledObject.position && wallsStopMoves()) {
      walk = passage.walkable(barriersFor(key), walkerAt(controlledObject), walkerAt(controlledObject, position));
      if (!walk.ok) {
        socket.emit('object-moved', { id, position: controlledObject.position });
        socket.emit('combat-denied', { reason: 'The way is blocked: walls, bars and shut doors stop you' });
        return;
      }
    }
    const previousObject = structuredClone(controlledObject);
    const previousCombat = snapshotField(map, 'combat');
    if (controlledObject.type === 'summon' && !isCampaignGM(socket.username)) {
      const problem = summonMoveProblem(key, controlledObject, position, true);
      if (problem) {
        socket.emit('object-moved', { id, position: controlledObject.position });
        socket.emit('combat-denied', { reason: problem });
        return;
      }
    }
    // In a started combat, combatant tokens move only on their turn, only by
    // their owner (GM excepted), and only within the turn's movement budget.
    const combat = map.combat;
    const c = combat && combat.started && ownValue(combat.combatants, id);
    if (c) {
      const old = sanitizePosition(controlledObject.position) || { x: 0, y: 0, z: 0 };
      const gm = isCampaignGM(socket.username);
      const isTheirTurn = combat.activeId === id && c.owner === socket.username;
      if (!gm && (!isTheirTurn || hasEffect(c, 'down'))) {
        socket.emit('object-moved', { id, position: old });
        socket.emit('combat-denied', { reason: hasEffect(c, 'down') ? `${c.name} is down` : "Not this token's turn" });
        return;
      }
      if (combat.activeId === id) {
        // XZ euclidean, matching the ruler: 1 world unit = 1 cell = 5 ft —
        // then whatever the ground under that line adds (slopes, water, snow).
        const flat = Math.hypot(position.x - old.x, position.z - old.z) * 5;
        let feet = flat, over = '';
        const priced = flat <= MAX_PRICED_MOVE_FEET && movementGround(key);
        if (priced) {
          const soles = controlledObject.type === 'character' ? CHARACTER_SOLE_DEPTH : TOKEN_SOLE_DEPTH;
          let modes = c.moveModes || [];
          if (hasEffect(c, 'flying') && !modes.includes('fly')) modes = modes.concat('fly');
          const result = groundModel.pathCost(
            { x: old.x, y: old.y - soles, z: old.z },
            { x: position.x, y: position.y - soles, z: position.z },
            priced.ground, { modes, snow: priced.rules.snow });
          feet = result.cost;
          over = groundModel.describeCost(result);
        }
        // Going round a wall costs the walk, not the straight line.
        if (walk && walk.detour && walk.cells * 5 > feet) { feet = walk.cells * 5; over = over || 'the way round'; }
        const remaining = c.speedFeet + c.dashFeet - c.movementUsedFeet;
        if (!gm && feet > remaining + 0.5) {
          const detail = over && feet > flat + 0.5 ? ` for ${Math.round(flat)} ft over ${over}` : '';
          socket.emit('object-moved', { id, position: old });
          socket.emit('combat-denied', { reason: `Too far: ${Math.round(feet)} ft${detail} (${Math.max(0, Math.round(remaining))} ft left)` });
          return;
        }
        c.movementUsedFeet += feet;
      }
    }
    const obj = controlledObject;
    const oldPos = { ...(obj.position || {}) };
    obj.position = position;
    const stoodUp = hasOwn(obj, 'pose');   // walking off a bed or a seat ends the pose
    delete obj.pose;
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
    broadcastMove(key, obj, oldPos, socket);
    if (stoodUp) emitObjectUpdated(key, obj, { pose: null });
    // The mover may be a viewer, a light or a wall: everyone else's sight
    // of every OTHER creature can have changed too.
    reconcileVision(key);
    // Moves are click-to-drop (not per-frame drags), so a live location
    // refresh for the Instances tab is cheap.
    if (obj.type === 'character') pushCharacterInstances();
    if (c) emitCombatState(key);
    // A caster who walks too far from what it summoned loses it.
    if (banishWhere(summon => summon.casterId === id && summon.leashFt && obj.position &&
        Math.hypot(summon.position.x - position.x, summon.position.z - position.z) * 5 > summon.leashFt + 2.5, key)) {
      saveMaps();
      flushSummonChanges();
    }
    // Walking into an area that lingers: its save is owed at once.
    if (c && map.combat && oldPos.x != null && zonesOnMove(key, map.combat, c, oldPos, position)) {
      persistCombat(key, snapshotField(map, 'combat'), []);
    }
  });

  // Fog of war and token vision: an object crossing out of what a player
  // may see pops out of existence for them (delete), and into it as a full
  // object — hidden objects simply don't exist on their side.
  function broadcastMove(key, obj, oldPos, exceptSocket) {
    const event = { id: obj.id, position: obj.position };
    touchVision();
    const unifiedMove = isUnifiedKey(key);
    const creatureMove = vision.isCreature(obj);
    forEachMapSocket(key, exceptSocket, (sock) => {
      if (isCampaignGM(sock.username) || ownsObject(sock.username, obj)) {
        sock.emit('object-moved', event);
        return;
      }
      const now = objectVisibleTo(sock.username, obj, key);
      const was = creatureMove
        ? shownSet(sock).has(obj.id)
        : obj.hidden !== true && (!unifiedMove || isRevealedAt(oldPos.x, oldPos.z));
      if (was && now) sock.emit('object-moved', event);
      else if (!was && now) {
        if (creatureMove) shownSet(sock).add(obj.id);
        sock.emit('object-added', projectObjectFor(sock.username, obj));
      } else if (was && !now) {
        if (creatureMove) shownSet(sock).delete(obj.id);
        sock.emit('object-deleted', { id: obj.id });
      }
    });
  }

  // Roll at the table. { actor, label, d20?: { bonus, mode: 'adv'|'dis', min?,
  // floor? }, dice?: [{ expr, type }], dc?, note?, gmOnly? } — a d20 test (`min`:
  // the die reads at least this, Reliable Talent; `floor`: the total is never
  // below this, Indomitable Might — both from the sheet), plain dice, or
  // both (a spell attack with its damage). Everyone in the campaign sees the
  // result; `gmOnly` keeps it between the roller and the GM.
  onCampaign('roll', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const now = Date.now();
    if (now - (socket.lastRollAt || 0) < 120) return;
    socket.lastRollAt = now;
    performRoll(payload, socket.username, combatDeny);
  });

  // The table roll itself, for `actor` (a username): the sender of `roll`, or
  // the player whose cast request the GM just allowed. → true once logged.
  function performRoll(payload, actor, deny) {
    const now = Date.now();
    // A cast names the slot it burns: { charId, level, max, pact? } (the
    // sheet's count — the server keeps only what is used). No slot, no roll.
    let slotNote = '';
    let healCharId = null; // a self-healing feature: its dice land on this character
    if (isRecord(payload.slot)) {
      const charId = boundedText(payload.slot.charId, 80);
      const character = charId && ownValue(charactersDB, charId);
      if (!character || !canAccessCharacter(actor, character)) return deny('Not your character');
      const level = clampInt(payload.slot.level, 1, 9, 0);
      const max = clampInt(payload.slot.max, 0, 20, 0);
      if (!level) return deny('No such spell slot');
      const pool = poolOf(charId);
      const fighting = combatantsOfCharacter(charId).filter(found => !found.c.statsPending && isRecord(found.c.slotMax));
      let left;
      delete pool.hdOpen; // casting ends the rest
      if (fighting.length) {
        // In a fight the combatant holds the count; the pool follows it.
        const { key: combatKey, c } = fighting[0];
        if (!takeCombatSlot(c, level, level)) return deny(`No level ${level} spell slots left`);
        slotNote = `level ${level} slot spent`;
        saveMaps();
        emitCombatState(combatKey);
      } else if (payload.slot.pact === true) {
        if (pool.pact >= max) return deny('No pact slots left: take a short rest');
        pool.pact += 1;
        left = max - pool.pact;
        slotNote = `pact slot spent (${left} left)`;
        savePools([charId]);
      } else {
        const used = pool.slots[level] || 0;
        if (used >= max) return deny(`No level ${level} spell slots left: take a long rest`);
        pool.slots[level] = used + 1;
        left = max - pool.slots[level];
        slotNote = `level ${level} slot spent (${left} left)`;
        savePools([charId]);
      }
    }
    // A concentration spell names its caster: { charId, name }. It replaces
    // whatever that character was holding.
    if (isRecord(payload.concentration)) {
      const charId = boundedText(payload.concentration.charId, 80);
      const character = charId && ownValue(charactersDB, charId);
      const name = boundedString(payload.concentration.name, 40);
      if (!character || !canAccessCharacter(actor, character)) return deny('Not your character');
      if (name) {
        const fighting = combatantsOfCharacter(charId)[0];
        if (fighting) { // cast off-turn through the table: the tracker holds it
          beginConcentration(fighting.key, maps[fighting.key].combat, fighting.c, name, 0);
          saveMaps();
          emitCombatState(fighting.key);
        } else {
          const pool = poolOf(charId);
          if (pool.conc && pool.conc.name !== name) slotNote = [slotNote, `${pool.conc.name} ends`].filter(Boolean).join(' · ');
          pool.conc = { name };
          if (banishWhere(summon => summon.held === true && summon.charId === charId && summon.spell !== name)) { saveMaps(); flushSummonChanges(); }
          savePools([charId]);
        }
        slotNote = [slotNote, 'concentrating'].filter(Boolean).join(' · ');
      }
    }
    // The CON save a hurt caster owes for the spell it holds: { charId }. The
    // server knows the DC; a failure ends the spell.
    let concCheck = null;
    if (isRecord(payload.concSave)) {
      const charId = boundedText(payload.concSave.charId, 80);
      const character = charId && ownValue(charactersDB, charId);
      if (!character || !canAccessCharacter(actor, character)) return deny('Not your character');
      const pool = hasOwn(poolsDB(), charId) ? poolsDB()[charId] : null;
      if (!pool || !pool.conc || !pool.conc.dc || !isRecord(payload.d20)) return deny('No concentration check is waiting');
      concCheck = { charId, pool };
    }
    // A feature used outside a fight names its pool: { charId, key, cost, max,
    // recharge, name }. In a fight the tracker spends it instead.
    if (isRecord(payload.resource)) {
      const charId = boundedText(payload.resource.charId, 80);
      const character = charId && ownValue(charactersDB, charId);
      if (!character || !canAccessCharacter(actor, character)) return deny('Not your character');
      if (combatantsOfCharacter(charId).length) return deny('In a fight, use it from the combat tracker');
      const resourceKey = boundedText(payload.resource.key, 40);
      const max = clampInt(payload.resource.max, 0, 999, 0);
      const cost = clampInt(payload.resource.cost, 1, 20, 1);
      if (!resourceKey) return deny('No such feature');
      const pool = poolOf(charId);
      const used = (pool.res[resourceKey] && pool.res[resourceKey].used) || 0;
      const name = boundedString(payload.resource.name, 40) || resourceKey;
      if (used + cost > max) return deny(`No ${name} uses left: take a rest`);
      pool.res[resourceKey] = { used: used + cost, recharge: payload.resource.recharge === 'long' ? 'long' : 'short' };
      delete pool.hdOpen;
      slotNote = [slotNote, `${name} ${max - used - cost}/${max}`].filter(Boolean).join(' · ');
      savePools([charId]);
      if (payload.resource.heal === true && pool.vit) healCharId = charId;
    }
    const entry = {
      id: crypto.randomUUID().slice(0, 8), ts: now, kind: 'roll',
      user: actor, gm: isCampaignGM(actor),
      actor: boundedString(payload.actor, 80) || actor,
      label: boundedString(payload.label, 120) || 'Roll'
    };
    if (isRecord(payload.d20)) {
      const bonus = clampInt(payload.d20.bonus, -50, 50, 0);
      const roll = rollD20(payload.d20.mode === 'adv', payload.d20.mode === 'dis');
      const minDie = clampInt(payload.d20.min, 1, 20, 1);
      const floor = clampInt(payload.d20.floor, 0, 30, 0);
      const used = Math.max(roll.used, minDie);
      entry.d20 = { rolls: roll.d20, used, mode: roll.mode, bonus, total: Math.max(used + bonus, floor) };
      if (used > roll.used) entry.d20.raised = roll.used;        // what the die showed before the minimum
      if (floor > used + bonus) entry.d20.floored = used + bonus; // what it added up to before the floor
      const dc = concCheck ? concCheck.pool.conc.dc : clampInt(payload.dc, 1, 60, 0);
      if (dc) { entry.dc = dc; entry.success = entry.d20.total >= dc; }
    }
    if (concCheck) {
      const held = concCheck.pool.conc.name;
      entry.label = `concentrates on ${held}`;
      if (entry.success) delete concCheck.pool.conc.dc;
      else {
        delete concCheck.pool.conc; slotNote = `${held} ends`;
        if (banishWhere(summon => summon.held === true && summon.charId === concCheck.charId)) { saveMaps(); flushSummonChanges(); }
      }
      savePools([concCheck.charId]);
    }
    const dice = (Array.isArray(payload.dice) ? payload.dice : []).slice(0, 4).map(part => {
      const rolled = isRecord(part) && rollExpression(part.expr);
      return rolled ? { ...rolled, type: boundedString(part.type, 24) } : null;
    }).filter(Boolean);
    if (dice.length) entry.dice = dice;
    if (healCharId && dice.length) {
      const character = charactersDB[healCharId];
      const vit = poolOf(healCharId).vit;
      const before = Math.min(vit.maxHP, character.hp && Number.isFinite(character.hp.current) ? character.hp.current : vit.maxHP);
      const after = Math.min(vit.maxHP, before + Math.max(0, dice[0].total));
      applyCharacterHP(healCharId, after);
      slotNote += ` · ${before} → ${after} HP`;
    }
    if (!entry.d20 && !entry.dice && !payload.note && !slotNote) return deny('Nothing to roll: use dice like 1d20+5 or 2d6');
    const note = [boundedString(payload.note, 400), slotNote].filter(Boolean).join(' · ');
    if (note) entry.note = note;
    if (payload.gmOnly === true) entry.gmOnly = true;
    const parts = [];
    if (entry.d20) {
      const rolled = entry.d20.raised != null ? entry.d20.raised : entry.d20.used;
      const shown = (entry.d20.mode ? `[${entry.d20.rolls.join(', ')}] → ${rolled}` : `${rolled}`) +
        (entry.d20.raised != null ? ` (counts as ${entry.d20.used})` : '');
      parts.push(`d20 ${shown} ${fmtSigned(entry.d20.bonus)} = ${entry.d20.total}` +
        (entry.d20.floored != null ? ` (raised from ${entry.d20.floored})` : '') +
        (entry.dc ? ` vs DC ${entry.dc}: ${entry.success ? 'success' : 'failure'}` : ''));
    }
    for (const part of dice) parts.push(`${part.expr} → ${part.total}${part.type ? ' ' + part.type : ''}`);
    entry.text = `${entry.actor}: ${entry.label}${parts.length ? ' — ' + parts.join(' · ') : ''}`;
    appendTableLog([entry]);
    return true;
  }

  // --- Cast requests ---------------------------------------------------------
  // Outside a fight a spell is asked for: the player's screen sends what the
  // cast would roll (and where its area was aimed), the GM allows or refuses.
  // Allowed, it is rolled here exactly like a `roll` from that player, the
  // map plays its effect (`cast-fx`) and the GM is told who stands in it.
  // Requests are table state for the session only (never saved).
  function castList() {
    if (!activeStore) return [];
    if (!Array.isArray(activeStore.castRequests)) activeStore.castRequests = [];
    return activeStore.castRequests;
  }
  function emitCastRequests() {
    io.to(campRoom(activeCampaignId())).emit('cast-requests', { requests: castList() });
  }
  function emitToMap(key, event, data, except = null) {
    if (isUnifiedKey(key)) emitToUnified(except, (sock) => sock.emit(event, data));
    else if (except) except.to(mapRoom(activeCampaignId(), key)).emit(event, data);
    else io.to(mapRoom(activeCampaignId(), key)).emit(event, data);
  }
  function castShape(raw) {
    if (!isRecord(raw)) return null;
    const shape = aoe.normalizeShape({ kind: raw.kind, sizeFt: raw.sizeFt, rangeFt: raw.rangeFt, widthFt: raw.widthFt });
    return aoe.shapeNeedsPoint(shape) || (shape.kind === 'self' && shape.sizeFt > 0) ? shape : null;
  }
  function castPoint(raw) {
    if (!isRecord(raw)) return null;
    const x = Number(raw.x), z = Number(raw.z);
    return Number.isFinite(x) && Number.isFinite(z) ? { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 } : null;
  }
  // The player's own token for that character on this map (or the GM's pick).
  function castToken(key, tokenId, charId, username) {
    const object = ownValue((maps[key] && maps[key].objects) || {}, boundedText(tokenId, 80));
    if (!object || !object.position || !object.characterData || object.characterData.id !== charId) return null;
    return object;
  }
  function tellCaster(request, text) {
    for (const sock of io.sockets.sockets.values()) {
      if (sock.username === request.user && sock.campaignId === activeCampaignId()) sock.emit('cast-denied', { id: request.id, spell: request.spell, reason: text });
    }
  }
  // The ground under a point, for something set down there (terrain only).
  function groundY(key, x, z, fallback) {
    try {
      const priced = movementGround(key);
      const y = priced ? Number(priced.ground.height(x, z)) : NaN;
      return Number.isFinite(y) ? y : fallback;
    } catch (_) { return fallback; }
  }
  function runCast(request, approver, deny) {
    const payload = {
      ...request.roll, actor: request.name,
      ...(request.slot ? { slot: request.slot } : {}),
      ...(request.concentration ? { concentration: { charId: request.charId, name: request.spell } } : {})
    };
    const fx = { action: request.spell, ...(request.type ? { type: request.type } : {}), ...(request.form ? { form: request.form, landed: true } : {}) };
    let caught = null;
    const objects = (maps[request.mapKey] && maps[request.mapKey].objects) || {};
    const token = request.tokenId ? castToken(request.mapKey, request.tokenId, request.charId) : null;
    if (token) fx.actor = token.id;
    let summonAt = null;
    if (token && request.summon) {
      const point = request.aim ? aoe.resolveAim(request.aim.shape, token.position, request.aim.point).center : null;
      summonAt = point && Number.isFinite(point.x) ? { x: point.x, z: point.z } : { x: token.position.x + 1, z: token.position.z };
    } else if (token && request.aim) {
      const aim = aoe.resolveAim(request.aim.shape, token.position, request.aim.point);
      const creatures = [];
      for (const object of Object.values(objects)) {
        if (!object || !object.position || (object.type !== 'token' && object.type !== 'character')) continue;
        creatures.push({ id: object.id, x: object.position.x, y: object.position.y, z: object.position.z });
      }
      const occ = visionState(request.mapKey).occ;
      const fromCaster = aim.kind === 'cone' || aim.kind === 'line' || aim.kind === 'self';
      caught = aoe.caughtIn(aim, creatures, {
        exclude: fromCaster ? token.id : null,
        blocked: (source, creature) => vision.sightBlocked(occ, source.x, creature.y + 0.5, source.z, creature.x, creature.y + 0.5, creature.z)
      }).map(id => {
        const object = objects[id];
        return boundedString((object.characterData && object.characterData.name) || object.name, 40) || 'a creature';
      });
      fx.area = areaFx(aim);
    }
    if (!performRoll(payload, request.user, deny)) return false;
    emitToMap(request.mapKey, 'cast-fx', { fx });
    if (summonAt) {
      const soles = token.position.y - CHARACTER_SOLE_DEPTH;
      conjure(request.mapKey, {
        ...request.summon, spell: request.spell, owner: request.user, charId: request.charId,
        casterId: token.id, casterName: request.name, held: request.concentration === true,
        position: { x: summonAt.x, y: groundY(request.mapKey, summonAt.x, summonAt.z, soles), z: summonAt.z }
      });
      saveMaps();
      flushSummonChanges();
    }
    // Light, Daylight, Darkness: it sits on the caster's token until changed
    // (the vision chip's carried-light picker, or the GM's inspector).
    if (token && request.light) {
      token.light = request.light;
      saveMaps();
      touchVision();
      emitObjectUpdated(request.mapKey, token, { light: token.light });
      reconcileVision(request.mapKey);
    }
    // Who stands in it is the GM's to know (some may be unseen by the party).
    if (caught) {
      appendTableLog([{
        id: crypto.randomUUID().slice(0, 8), ts: Date.now(), kind: 'roll', user: approver, gm: true, gmOnly: true,
        actor: request.name, label: `${request.spell}: ${caught.length ? `${caught.length} in the area` : 'no one in the area'}`,
        ...(caught.length ? { note: caught.join(', ') } : {}),
        text: `${request.name}'s ${request.spell} catches ${caught.length ? caught.join(', ') : 'no one'}`
      }]);
    }
    return true;
  }

  onCampaign('get-cast-requests', () => {
    if (socket.username) socket.emit('cast-requests', { requests: castList() });
  });

  // The template a player is still moving about: shown, faded, to the others
  // on the map. { tokenId, name, type, shape, point | null }. Nothing is kept.
  onCampaign('cast-aim', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const now = Date.now();
    const point = castPoint(payload.point);
    if (point && now - (socket.lastCastAimAt || 0) < 40) return;
    socket.lastCastAimAt = now;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const tokenId = boundedText(payload.tokenId, 80);
    const object = ownValue((maps[key] && maps[key].objects) || {}, tokenId);
    if (!object || !object.characterData) return;
    const character = ownValue(charactersDB, object.characterData.id);
    if (!character || !canAccessCharacter(socket.username, character)) return;
    const shape = castShape(payload.shape);
    emitToMap(key, 'cast-aim', {
      user: socket.username, tokenId, name: boundedString(payload.name, 40) || 'a spell',
      type: boundedString(payload.type, 20), shape, point: shape ? point : null
    }, socket);
  });

  onCampaign('cast-request', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return combatDeny('Not your character');
    const spell = boundedString(payload.spell, 40);
    const raw = isRecord(payload.roll) ? payload.roll : {};
    if (!spell) return combatDeny('Cast what?');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const roll = { label: boundedString(raw.label, 120) || `casts ${spell}`, note: boundedString(raw.note, 400) || `casts ${spell}` };
    if (isRecord(raw.d20)) roll.d20 = { bonus: clampInt(raw.d20.bonus, -50, 50, 0), mode: raw.d20.mode === 'adv' ? 'adv' : raw.d20.mode === 'dis' ? 'dis' : '' };
    if (Array.isArray(raw.dice)) {
      roll.dice = raw.dice.slice(0, 4).filter(isRecord).map(part => ({ expr: boundedString(part.expr, 40), type: boundedString(part.type, 24) }));
    }
    const request = {
      id: crypto.randomUUID().slice(0, 8), ts: Date.now(), user: socket.username, charId,
      name: boundedString(character.name, 80) || 'Adventurer', spell, level: clampInt(payload.level, 0, 9, 0),
      type: boundedString(payload.type, 20), mapKey: key, roll,
      concentration: payload.concentration === true,
      ...(SPELL_FORMS.has(payload.form) ? { form: payload.form } : {}),
      ...(vision.normalizeLight(payload.light) ? { light: vision.normalizeLight(payload.light) } : {}),
      ...(normalizeSummon(payload.summon) ? { summon: normalizeSummon(payload.summon) } : {})
    };
    if (isRecord(payload.slot)) {
      request.slot = { charId, level: clampInt(payload.slot.level, 1, 9, 1), max: clampInt(payload.slot.max, 0, 20, 0), ...(payload.slot.pact === true ? { pact: true } : {}) };
    }
    const token = castToken(key, payload.tokenId, charId);
    if (token) {
      request.tokenId = token.id;
      const shape = isRecord(payload.aim) ? castShape(payload.aim.shape) : null;
      const point = shape ? (castPoint(payload.aim.point) || { x: token.position.x, z: token.position.z }) : null;
      if (shape) {
        request.aim = { shape, point };
        request.area = aoe.describeShape(shape);
      }
    }
    if (isCampaignGM(socket.username)) { runCast(request, socket.username, combatDeny); return; } // the GM needs nobody's leave
    const list = castList().filter(other => !(other.user === request.user && other.charId === charId));
    list.push(request);
    activeStore.castRequests = list.slice(-20);
    emitCastRequests();
  });

  onCampaign('cancel-cast', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const id = boundedText(payload.id, 24);
    const list = castList();
    const request = list.find(other => other.id === id);
    if (!request || (request.user !== socket.username && !isCampaignGM(socket.username))) return;
    activeStore.castRequests = list.filter(other => other !== request);
    emitCastRequests();
  });

  onCampaign('resolve-cast', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    if (!isRecord(payload)) return;
    const id = boundedText(payload.id, 24);
    const list = castList();
    const request = list.find(other => other.id === id);
    if (!request) return;
    activeStore.castRequests = list.filter(other => other !== request);
    if (payload.approve === true) {
      // What stops it now (no slot left) goes to both of them.
      runCast(request, socket.username, (reason) => { combatDeny(reason); tellCaster(request, reason); });
    } else {
      tellCaster(request, `The GM refused ${request.spell}`);
    }
    emitCastRequests();
  });

  onCampaign('get-roll-log', () => {
    if (!socket.username) return;
    socket.emit('roll-log', { entries: tableLog().filter(entry => tableEntryVisibleTo(socket.username, entry)) });
  });

  onCampaign('clear-roll-log', () => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    tableLog().length = 0;
    saveTableLog();
    io.to(campRoom(activeCampaignId())).emit('roll-log', { entries: [] });
  });

  onCampaign('delete-roll-log-entry', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const log = tableLog();
    const kept = log.filter(entry => entry.id !== id);
    if (kept.length === log.length) return;
    activeStore.rolls = kept;
    if (!saveTableLog()) { activeStore.rolls = log; return combatDeny('Could not save the log'); }
    // Everyone gets their own filtered view of the shortened log.
    const campaignId = activeCampaignId();
    for (const sock of io.sockets.sockets.values()) {
      if (!sock.username || sock.campaignId !== campaignId) continue;
      sock.emit('roll-log', { entries: tableLog().filter(entry => tableEntryVisibleTo(sock.username, entry)) });
    }
  });

  // --- Dice macros: a personal saved roll per campaign ---
  function denyMacro(message) {
    socket.emit('macro-denied', { error: message });
  }

  onCampaign('get-macros', () => {
    if (!socket.username) return;
    socket.emit('macros', { macros: macrosDB().filter(macro => sameUser(macro.owner, socket.username)) });
  });

  onCampaign('save-macro', (payload) => {
    if (!socket.username) return;
    const now = Date.now();
    if (now - (socket.macroAt || 0) < 500) return denyMacro('Slow down a moment');
    const macro = sanitizeMacro(isRecord(payload) ? payload.macro : {});
    if (!macro) return denyMacro('A macro needs dice, like d20+5 or 2d6');
    macro.owner = socket.username;
    const macros = macrosDB();
    const existing = macros.find(known => known.id === macro.id && sameUser(known.owner, socket.username));
    if (existing) {
      const owner = existing.owner;
      Object.assign(existing, macro, { owner });
    } else {
      if (macros.length >= MACROS_LIMIT) return denyMacro('Your macro list is full (50)');
      macros.push(macro);
    }
    if (!saveMacros()) return denyMacro('Could not save the macro');
    socket.macroAt = now;
    deliverMacros(socket.username);
  });

  onCampaign('delete-macro', (payload) => {
    if (!socket.username) return;
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const macros = macrosDB();
    const kept = macros.filter(macro => !(macro.id === id && sameUser(macro.owner, socket.username)));
    if (kept.length === macros.length) return;
    activeStore.macros = kept;
    if (!saveMacros()) { activeStore.macros = macros; return denyMacro('Could not save the macros'); }
    deliverMacros(socket.username);
  });

  // --- GM bookmarks: named camera spots on this campaign's maps ---
  function denyBookmark(message) {
    socket.emit('bookmark-denied', { error: message });
  }

  onCampaign('get-bookmarks', () => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyBookmark('GM only');
    socket.emit('bookmarks', { bookmarks: bookmarksDB() });
  });

  onCampaign('save-bookmark', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyBookmark('GM only');
    const name = isRecord(payload) ? boundedText(payload.name, 40) : '';
    const mapKey = isRecord(payload) ? boundedString(payload.mapKey, 80) : '';
    const pose = isRecord(payload) ? sanitizePose(payload.pose) : null;
    if (!name || !mapKey || !pose) return denyBookmark('A bookmark needs a name and a view to remember');
    const bookmarks = bookmarksDB();
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const existing = id && bookmarks.find(bookmark => bookmark.id === id);
    if (existing) {
      existing.name = name;
      existing.mapKey = mapKey;
      existing.pose = pose;
    } else {
      if (bookmarks.length >= BOOKMARKS_LIMIT) return denyBookmark('The bookmark list is full (40)');
      bookmarks.push({ id: crypto.randomUUID().slice(0, 8), name, mapKey, pose });
    }
    if (!saveBookmarks()) return denyBookmark('Could not save the bookmark');
    deliverBookmarks();
  });

  onCampaign('delete-bookmark', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyBookmark('GM only');
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const bookmarks = bookmarksDB();
    const kept = bookmarks.filter(bookmark => bookmark.id !== id);
    if (kept.length === bookmarks.length) return;
    activeStore.bookmarks = kept;
    if (!saveBookmarks()) { activeStore.bookmarks = bookmarks; return denyBookmark('Could not save the bookmarks'); }
    deliverBookmarks();
  });

  // --- GM encounter library: saved monster groups (gm.js places them) ---
  function denyEncounter(message) {
    socket.emit('encounter-denied', { error: message });
  }

  onCampaign('get-encounters', () => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyEncounter('GM only');
    socket.emit('encounters', { encounters: encountersDB() });
  });

  onCampaign('save-encounter', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyEncounter('GM only');
    const encounter = sanitizeEncounter(payload);
    if (!encounter) return denyEncounter('An encounter needs a name and at least one monster');
    const encounters = encountersDB();
    const existing = encounters.find(entry => entry.id === encounter.id);
    if (existing) {
      existing.name = encounter.name;
      existing.members = encounter.members;
    } else {
      if (encounters.length >= ENCOUNTERS_LIMIT) return denyEncounter('The encounter library is full (25)');
      encounters.push(encounter);
    }
    if (!saveEncounters()) return denyEncounter('Could not save the encounter');
    deliverEncounters();
  });

  onCampaign('delete-encounter', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyEncounter('GM only');
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const encounters = encountersDB();
    const kept = encounters.filter(entry => entry.id !== id);
    if (kept.length === encounters.length) return;
    activeStore.encounters = kept;
    if (!saveEncounters()) { activeStore.encounters = encounters; return denyEncounter('Could not save the encounters'); }
    deliverEncounters();
  });

  // --- Table chat: OOC conversation and private whispers (both screens) ---
  function denyChat(message) {
    socket.emit('chat-denied', { error: message });
  }

  onCampaign('get-chat', () => {
    if (!socket.username) return;
    socket.emit('chat-log', { messages: chatDB().filter(entry => chatEntryVisibleTo(socket.username, entry)) });
  });

  onCampaign('chat-send', (payload) => {
    if (!socket.username) return;
    const now = Date.now();
    if (now - (socket.chatAt || 0) < CHAT_GAP_MS) return denyChat('Slow down a moment');
    const text = isRecord(payload) ? boundedText(payload.text, CHAT_TEXT_LIMIT) : '';
    if (!text) return denyChat('A message needs some text');
    const to = isRecord(payload) ? boundedText(payload.to, MAX_USERNAME_LENGTH) : '';
    if (to && sameUser(to, socket.username)) return denyChat('A whisper needs someone else');
    if (to) {
      // Target anyone seated at this table, or an account that can come to it
      // (so an invited player can be whispered before they log in).
      const seated = [...io.sockets.sockets.values()]
        .some(sock => sock.campaignId === activeCampaignId() && sameUser(sock.username, to));
      const known = auth.list().some(user => !user.disabled && sameUser(user.username, to));
      if (!seated && !known) return denyChat('No one by that name at this table');
    }
    const messages = chatDB();
    const message = { id: crypto.randomUUID().slice(0, 8), at: now, from: socket.username, to: to || null, text };
    messages.push(message);
    if (messages.length > CHAT_LIMIT) messages.splice(0, messages.length - CHAT_LIMIT);
    if (!saveChat()) {
      const last = messages.lastIndexOf(message);
      if (last >= 0) messages.splice(last, 1);
      return denyChat('Could not save the message');
    }
    socket.chatAt = now;
    deliverChat(message);
  });

  // --- Campaign journal: GM notes, party treasury, XP log ---
  onCampaign('get-journal', () => {
    if (!socket.username) return;
    socket.emit('journal', journalPayloadFor(socket.username));
  });

  function denyJournal(message) {
    socket.emit('journal-denied', { error: message });
  }

  onCampaign('save-journal-entry', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyJournal('GM only');
    if (!isRecord(payload) || !isRecord(payload.entry)) return denyJournal('Invalid entry');
    const raw = payload.entry;
    const text = boundedMultilineText(raw.text, JOURNAL_TEXT_LIMIT);
    if (!text) return denyJournal('An entry needs some text');
    const journal = journalDB();
    const now = Date.now();
    const id = boundedString(raw.id, 20);
    const existing = id && journal.entries.find(entry => entry.id === id);
    if (existing) {
      existing.title = boundedText(raw.title, 120) || existing.title;
      existing.text = text;
      existing.kind = JOURNAL_KINDS.includes(raw.kind) ? raw.kind : existing.kind;
      existing.visible = raw.visible === 'gm' ? 'gm' : 'party';
      existing.updated = now;
    } else {
      if (journal.entries.length >= JOURNAL_LIMIT) return denyJournal('The journal is full');
      journal.entries.push({
        id: crypto.randomUUID().slice(0, 8),
        title: boundedText(raw.title, 120) || 'Untitled',
        text,
        kind: JOURNAL_KINDS.includes(raw.kind) ? raw.kind : 'quest',
        visible: raw.visible === 'gm' ? 'gm' : 'party',
        at: now, updated: now
      });
    }
    if (!saveJournal()) return denyJournal('Could not save the journal');
    pushJournal();
  });

  onCampaign('delete-journal-entry', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyJournal('GM only');
    const id = isRecord(payload) ? boundedString(payload.id, 20) : '';
    const journal = journalDB();
    const before = journal.entries.length;
    journal.entries = journal.entries.filter(entry => entry.id !== id);
    if (journal.entries.length === before) return;
    if (!saveJournal()) return denyJournal('Could not save the journal');
    pushJournal();
  });

  onCampaign('update-treasury', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyJournal('GM only');
    if (!isRecord(payload) || !isRecord(payload.treasury)) return denyJournal('Invalid treasury');
    const journal = journalDB();
    const coins = {};
    for (const coin of TREASURY_COINS) {
      const value = journalInt(payload.treasury[coin], 0, 100000000, 0);
      if (value) coins[coin] = value;
    }
    journal.treasury = coins;
    if (!saveJournal()) return denyJournal('Could not save the treasury');
    pushJournal();
  });

  onCampaign('set-xp-mode', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyJournal('GM only');
    const mode = isRecord(payload) && payload.mode === 'xp' ? 'xp' : 'milestone';
    const journal = journalDB();
    if (journal.xp.mode === mode) return;
    journal.xp.mode = mode;
    if (!saveJournal()) return denyJournal('Could not save the XP mode');
    pushJournal();
  });

  // GM awards XP (or a milestone note) to named characters: the log entry is
  // party information, the points land on each sheet as `char.xp`.
  onCampaign('award-xp', (payload) => {
    if (!socket.username) return;
    if (!isCampaignGM(socket.username)) return denyJournal('GM only');
    if (!isRecord(payload)) return denyJournal('Invalid award');
    const text = boundedText(payload.text, 240);
    const xp = journalInt(payload.xp, 0, 100000000, 0);
    if (!text && !xp) return denyJournal('An award needs a name or points');
    const journal = journalDB();
    if (journal.xp.awards.length >= JOURNAL_LIMIT) return denyJournal('The XP log is full');
    const charIds = sanitizeReferenceArray(payload.charIds, 32, 80)
      .filter(id => hasOwn(charactersDB, id));
    journal.xp.awards.push({
      id: crypto.randomUUID().slice(0, 8), at: Date.now(),
      text: text || `${xp} XP`, xp, charIds
    });
    if (!saveJournal()) return denyJournal('Could not save the XP log');
    const changed = [];
    if (xp) {
      for (const id of charIds) {
        const char = ownValue(charactersDB, id);
        if (!char) continue;
        char.xp = Math.min(100000000, (Number.isFinite(char.xp) ? char.xp : 0) + xp);
        changed.push(char);
      }
      if (changed.length && !saveCharacters()) {
        for (const char of changed) delete char.xp;
        journal.xp.awards.pop();
        saveJournal();
        return denyJournal('Could not save the character sheets');
      }
    }
    pushJournal();
    for (const char of changed) emitCharacterChange('character-updated', char, char.owner);
  });

  // Pools and rests. Everyone at the table sees what is spent and who asked
  // for a rest; a player asks, the GM grants (or grants one unasked).
  onCampaign('get-pools', () => {
    if (!socket.username) return;
    socket.emit('pools', { pools: poolsDB(), requests: restList() });
  });

  // The owner's screen reports what the sheet derives (the server has no
  // SRD): maximum hit points, CON modifier and hit dice by die size.
  onCampaign('set-vitals', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return;
    const vit = sanitizeVitals(payload);
    const pool = poolOf(charId);
    if (!vit || JSON.stringify(pool.vit || null) === JSON.stringify(vit)) return;
    pool.vit = vit;
    savePools([charId]);
  });

  // During a short rest: roll one hit die + CON and heal that much.
  onCampaign('spend-hit-die', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return combatDeny('Not your character');
    const pool = poolOf(charId);
    if (!pool.hdOpen && !isCampaignGM(socket.username)) return combatDeny('Hit dice are spent during a short rest: ask the GM for one');
    if (combatantsOfCharacter(charId).length) return combatDeny('No resting in the middle of a fight');
    if (!pool.vit) return combatDeny('Open this character on its player screen first');
    const die = clampInt(payload.die, 6, 12, 0);
    const max = pool.vit.hd[die] || 0;
    const used = pool.hd[die] || 0;
    if (!HIT_DICE.includes(die) || used >= max) return combatDeny(`No d${die} hit dice left`);
    const rolled = 1 + Math.floor(Math.random() * die);
    const healed = Math.max(0, rolled + pool.vit.con);
    const before = Math.min(pool.vit.maxHP, character.hp && Number.isFinite(character.hp.current) ? character.hp.current : pool.vit.maxHP);
    const after = Math.min(pool.vit.maxHP, before + healed);
    pool.hd[die] = used + 1;
    applyCharacterHP(charId, after);
    savePools([charId]);
    const name = character.name || 'A character';
    appendTableLog([{
      id: crypto.randomUUID().slice(0, 8), ts: Date.now(), kind: 'roll', user: socket.username, gm: isCampaignGM(socket.username),
      actor: name, label: 'spends a hit die',
      dice: [{ expr: `1d${die}${pool.vit.con ? fmtSigned(pool.vit.con).replace(/\s+/g, '') : ''}`, rolls: [rolled], total: healed, type: 'healing' }],
      note: `${before} → ${after} HP · d${die} hit dice ${max - used - 1}/${max}`,
      text: `${name} spends a hit die: ${healed} healed (${before} → ${after} HP)`
    }]);
  });

  onCampaign('end-rest', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return;
    const pool = poolOf(charId);
    if (!pool.hdOpen) return;
    delete pool.hdOpen;
    savePools([charId]);
  });

  onCampaign('request-rest', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const charId = boundedText(payload.charId, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(socket.username, character)) return combatDeny('Not your character');
    const kind = REST_KINDS.includes(payload.kind) ? payload.kind : null;
    if (!kind) return combatDeny('Short rest or long rest?');
    if (isCampaignGM(socket.username)) { // the GM needs nobody's leave
      const problem = applyRest(charId, kind, socket.username);
      if (problem) combatDeny(problem);
      return;
    }
    if (combatantsOfCharacter(charId).length) return combatDeny('No resting in the middle of a fight');
    const list = restList().filter(request => request.charId !== charId).slice(-39);
    list.push({
      id: crypto.randomUUID().slice(0, 8), charId, name: boundedString(character.name, 80) || 'Adventurer',
      owner: socket.username, kind, ts: Date.now()
    });
    setRestList(list);
    emitRestRequests();
  });

  onCampaign('cancel-rest', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const id = boundedText(payload.id, 20);
    const list = restList();
    const request = list.find(candidate => candidate.id === id);
    if (!request || (request.owner !== socket.username && !isCampaignGM(socket.username))) return;
    setRestList(list.filter(candidate => candidate !== request));
    emitRestRequests();
  });

  onCampaign('resolve-rest', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const id = isRecord(payload) ? boundedText(payload.id, 20) : '';
    const list = restList();
    const request = list.find(candidate => candidate.id === id);
    if (!request) return;
    if (payload.approve === true) {
      const problem = applyRest(request.charId, request.kind, socket.username);
      if (problem) return combatDeny(problem);
    }
    setRestList(list.filter(candidate => candidate !== request));
    emitRestRequests();
    if (payload.approve !== true) {
      io.to(campRoom(activeCampaignId())).emit('rest-denied', { charId: request.charId, kind: request.kind, owner: request.owner, name: request.name });
    }
  });

  // GM: a rest for the whole party (every character with a token on a map),
  // or for the characters named.
  onCampaign('grant-rest', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const kind = isRecord(payload) && REST_KINDS.includes(payload.kind) ? payload.kind : null;
    if (!kind) return;
    let ids = Array.isArray(payload.charIds) ? payload.charIds.map(id => boundedText(id, 80)).filter(Boolean).slice(0, 100) : null;
    if (!ids) {
      const onMaps = new Set();
      for (const map of Object.values(maps)) {
        for (const object of Object.values((map && map.objects) || {})) {
          const id = object && object.characterData && object.characterData.id;
          if (id && hasOwn(charactersDB, id)) onMaps.add(id);
        }
      }
      ids = [...onMaps];
    }
    if (!ids.length) return combatDeny('No characters on the map to rest');
    const problems = ids.map(id => applyRest(id, kind, socket.username)).filter(Boolean);
    setRestList(restList().filter(request => !ids.includes(request.charId)));
    emitRestRequests();
    if (problems.length) combatDeny(problems[0]);
  });

  // Use a piece of furniture (shared/passage.js PROP_POSES): lie down on a
  // cot, sit on a bench or a high seat. The character has to stand within
  // reach with nothing in between; using it again, or walking off, gets up.
  // `tokenId` picks which of the sender's characters (the GM: any character).
  onCampaign('use-prop', (payload) => {
    if (!socket.username || !isRecord(payload)) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const prop = ownValue(map.objects, boundedText(payload.id, 80));
    const kind = prop && prop.type === 'prop' && prop.position && passage.PROP_POSES[prop.kind];
    if (!kind) return;
    const gm = isCampaignGM(socket.username);
    const wanted = boundedText(payload.tokenId, 80);
    const distanceTo = (o) => Math.hypot(o.position.x - prop.position.x, o.position.z - prop.position.z);
    const token = Object.values(map.objects)
      .filter(o => o.type === 'character' && o.position && (gm || ownsObject(socket.username, o)) && (!wanted || o.id === wanted))
      .sort((a, b) => distanceTo(a) - distanceTo(b))[0];
    if (!token) return combatDeny(gm ? 'Select a character first' : 'Place a character first');
    const combat = map.combat;
    const c = combat && combat.started && ownValue(combat.combatants, token.id);
    if (c && !gm && combat.activeId !== token.id) return combatDeny("Not this token's turn");
    const previousObject = structuredClone(token);
    const oldPos = { ...token.position };
    const using = isRecord(token.pose) && token.pose.prop === prop.id;
    if (using) {
      delete token.pose;
    } else {
      if (!gm) {
        const near = distanceTo(token) <= passage.USE_REACH && Math.abs(token.position.y - prop.position.y) <= 3;
        if (!near) return combatDeny('Move a character next to it first');
        if (wallsStopMoves() && !passage.walkable(barriersFor(key), walkerAt(token), walkerAt(token, prop.position)).ok) {
          return combatDeny('The way is blocked');
        }
      }
      const taken = Object.values(map.objects).some(o => o !== token && isRecord(o.pose) && o.pose.prop === prop.id);
      if (taken) return combatDeny('Someone is already there');
      token.position = { x: prop.position.x, y: prop.position.y + CHARACTER_SOLE_DEPTH, z: prop.position.z };
      token.pose = { kind, prop: prop.id, propKind: prop.kind, rot: Math.round(boundedNumber(prop.rot, 0, 3, 0)) };
    }
    if (!saveMaps()) {
      map.objects[token.id] = previousObject;
      socket.emit('error', 'Could not save the pose');
      return;
    }
    if (!using) broadcastMove(key, token, oldPos, null);
    emitObjectUpdated(key, token, { pose: token.pose || null });
    reconcileVision(key);
    if (!using) pushCharacterInstances();
  });

  onCampaign('delete-object', (data) => {
    if (!socket.username) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = data && data.id ? boundedText(data.id, 80) : '';
    const obj = id ? ownValue(map.objects, id) : null;
    if (obj && (isCampaignGM(socket.username) || ownsObject(socket.username, obj))) {
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
      else io.to(mapRoom(activeCampaignId(), key)).emit('object-deleted', event);
      if (banishWhere(summon => summon.casterId === id, key)) saveMaps();
      flushSummonChanges(); // those, and any a lost concentration took along
      reconcileVision(key);
      if (wasCharacter) pushCharacterInstances();
      if (obj.type === 'portal') pushDungeons();
      if (combatChanged) emitCombatState(key);
    }
  });

  // --- Combat handlers. All act on the current room's combat; failed checks
  // answer only the offending socket with combat-denied (never 'error': the
  // player client routes that to the login modal). ---
  function combatDeny(reason) { socket.emit('combat-denied', { reason }); }
  // Lights a spell put on (or took off) tokens: tell the screens, re-rule sight.
  function flushLightChanges() {
    const keys = new Set();
    for (const { key, id } of lightChanges.splice(0)) {
      const object = ownValue((maps[key] && maps[key].objects) || {}, id);
      if (!object) continue;
      emitObjectUpdated(key, object, { light: object.light || null });
      keys.add(key);
    }
    for (const key of keys) reconcileVision(key);
  }

  function persistCombat(key, previousCombat, stagedCharacterHP = []) {
    const map = getMap(key);
    sweepZones(key, map.combat, stagedCharacterHP, rollsSaveNow);
    sweepConcentration(key, map.combat, rollsSaveNow);
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
      flushLightChanges();
      flushSummonChanges();
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
  function canControl(c) { return isCampaignGM(socket.username) || (!!c.owner && c.owner === socket.username); }
  const clampInt = (v, min, max, dflt) => {
    v = Number(v);
    return isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt;
  };

  onCampaign('combat-start', () => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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

  onCampaign('combat-end', () => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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
  onCampaign('combat-set-stats', (payload) => {
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
    if (Array.isArray(payload.attacks)) c.attacks = normalizeAttacks(payload.attacks);
    c.abilities = normalizeAbilities(payload.abilities);
    c.riders = normalizeRiders(payload.riders);
    c.resources = normalizeResources(payload.resources);
    c.moveModes = normalizeMoveModes(payload.moveModes);
    // A character walks into the fight with what it has left (pools.json);
    // per-fight and per-turn pools, and monsters, start full.
    const carried = c.kind === 'character' && c.charId && hasOwn(poolsDB(), c.charId) ? poolsDB()[c.charId] : null;
    for (const [resourceKey, resource] of Object.entries(c.resources)) {
      const spent = carried && (resource.recharge === 'short' || resource.recharge === 'long') && carried.res[resourceKey];
      resource.current = Math.max(0, resource.max - (spent ? spent.used : 0));
    }
    Object.assign(c, normalizeTurnState({
      attacksPerAction: payload.attacksPerAction, critRange: payload.critRange
    }));
    const ABILS = ['str','dex','con','int','wis','cha'];
    c.saves = {};
    for (const a of ABILS) c.saves[a] = clampInt(payload.saves && payload.saves[a], -20, 30, 0);
    c.spellAtk = clampInt(payload.spellAtk, -10, 30, 0);
    c.spellDC  = clampInt(payload.spellDC, 1, 40, 8);
    c.slots = {};
    c.slotMax = {};
    for (let l = 1; l <= 9; l++) {
      c.slotMax[l] = clampInt(payload.slots && payload.slots[l], 0, 20, 0);
      c.slots[l] = Math.max(0, c.slotMax[l] - ((carried && carried.slots[l]) || 0));
    }
    const pact = sanitizePact(payload.pact, (carried && carried.pact) || 0);
    if (pact) c.pact = pact; else delete c.pact;
    if (Array.isArray(payload.spells)) c.spells = normalizeSpells(payload.spells);
    c.saveMods = normalizeSaveMods(payload.saveMods);
    if (carried && carried.conc) c.concentration = { name: carried.conc.name, effects: [] };
    if (!c.hp) c.hp = { current: c.maxHP };
    c.statsPending = false;
    persistCombat(key, previousCombat);
  });

  onCampaign('combat-roll-initiative', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (c.initiative != null && !isCampaignGM(socket.username)) return combatDeny('Initiative already rolled');
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

  onCampaign('combat-begin', () => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || combat.started) return;
    if (!Object.keys(combat.combatants).length) return combatDeny('No combatants');
    const previousCombat = snapshotField(getMap(key), 'combat');
    beginCombat(key, combat);
    persistCombat(key, previousCombat);
  });

  // One weapon attack inside the Attack action, an Extra Attack or a granted
  // bonus-action strike. Riders (Sneak Attack, Rage) add their dice on a hit.
  function resolveWeaponAttack(key, combat, c, target, atk, payload, stagedCharacterHP) {
    const sight = sightModifiers(key, c, target);
    const roll = rollD20(payload.advantage === true || sight.advantage, hasEffect(target, 'dodging') || sight.disadvantage);
    const crit = roll.used >= (c.critRange || 20);
    const total = roll.used + atk.attack;
    const hit = roll.used !== 1 && (crit || total >= target.ac);
    let text = `${c.name} attacks ${target.name} (${atk.name})${sight.note}: d20 ${roll.text} ${fmtSigned(atk.attack)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
    const entry = {
      kind: 'attack', actorName: c.name, targetName: target.name,
      roll: { d20: roll.d20, used: roll.used, mod: atk.attack, total, vs: target.ac, hit, crit, disadvantage: roll.mode < 0, advantage: roll.mode > 0 }
    };
    entry.fx = combatFx(c, target, atk.name, atk.damageType, hit);
    if (hit) {
      const damageParts = Array.isArray(atk.damageParts) && atk.damageParts.length > 1
        ? atk.damageParts
        : [{ damage: atk.damage, damageType: atk.damageType }];
      const rolledParts = damageParts.map(part => ({
        ...rollDamage(part.damage, crit),
        damageType: boundedString(part.damageType, 20)
      }));
      // Automatic riders always apply; the rest only when the attacker asked.
      const requested = new Set((Array.isArray(payload.riders) ? payload.riders : []).slice(0, 8).map(Number));
      const riderNames = [];
      (c.riders || []).forEach((rider, index) => {
        if (!rider.auto && !requested.has(index)) return;
        if (!riderApplies(rider, atk, c, c.ridersUsed || [], index)) return;
        rolledParts.push({ ...rollDamage(rider.damage, crit), damageType: rider.damageType || '' });
        riderNames.push(rider.name);
        if (rider.oncePerTurn) c.ridersUsed = [...(c.ridersUsed || []), index];
      });
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
      if (riderNames.length) text += ` [${riderNames.join(', ')}]`;
      if (rolledParts.length > 1) text += ` · ${damageTotal} total`;
      const next = applyDamageToTarget(target, damageTotal, stagedCharacterHP);
      if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
    }
    entry.text = text;
    pushLog(key, combat, entry);
  }

  // Whose saving throw the acting user rolls on the spot: their own creatures
  // (for the GM: everything no player owns). The rest wait for their player.
  function rollsSaveNow(target) {
    if (target.owner) return target.owner === socket.username;
    return isCampaignGM(socket.username);
  }
  function abilityShape(ability) {
    const fromCaster = ability.area === 'cone' || ability.area === 'line' || ability.area === 'cube' || ability.area === 'self';
    return aoe.normalizeShape({ kind: ability.area, sizeFt: ability.areaFt, rangeFt: fromCaster ? 0 : ability.rangeFt });
  }

  // A feature ability: attack-roll, save-for-damage, heal or utility. Returns
  // an error string when it cannot be used (nothing is spent in that case).
  function resolveAbility(key, combat, c, ability, payload, stagedCharacterHP) {
    // An area with a size is aimed, and the server says who stands in it; the
    // rest (one creature, or a shape the data gives no size for) name targets.
    const shape = abilityShape(ability);
    const aimed = ability.type === 'save' && (aoe.shapeNeedsPoint(shape) || (shape.kind === 'self' && shape.sizeFt > 0));
    let targets = [], aim = null;
    if (aimed) {
      if (shape.kind !== 'self' && !isRecord(payload.aim)) return `Aim ${ability.name} first`;
      const area = areaTargets(key, combat, c, shape, payload.aim);
      if (typeof area === 'string') return area;
      ({ aim, targets } = area);
    } else {
      const requested = Array.isArray(payload.targetIds) ? payload.targetIds : (payload.targetId ? [payload.targetId] : []);
      for (const id of requested.slice(0, 12)) {
        const target = ownValue(combat.combatants, id);
        if (target && !targets.includes(target)) targets.push(target);
      }
      if (targets.length > ability.maxTargets) return `${ability.name} affects at most ${ability.maxTargets} target(s)`;
    }
    const offensive = ability.type === 'attack' || ability.type === 'save';
    if (offensive && !aimed && !targets.length) return `Pick a target for ${ability.name}`;
    if (offensive && !aimed && targets.includes(c)) return "Can't target yourself";
    if (ability.rechargeOn && ability.spent) return `${ability.name} has not recharged`;
    const resource = ability.resource ? ownValue(c.resources, ability.resource) : null;
    if (ability.resource && (!resource || resource.current < ability.resourceCost)) {
      return `No ${resource ? resource.name : ability.name} uses left`;
    }
    if (ability.cost === 'action' && c.actionUsed) return 'Action already used this turn';
    if (ability.cost === 'bonus' && c.bonusUsed) return 'Bonus action already used this turn';

    if (resource) resource.current -= ability.resourceCost;
    if (ability.rechargeOn) ability.spent = true;
    if (ability.cost === 'action') { c.actionUsed = true; c.attacksLeft = 0; }
    if (ability.cost === 'bonus') c.bonusUsed = true;
    const spent = resource ? ` (${resource.name} ${resource.current}/${resource.max})` : '';
    const applyEffect = (target) => {
      if (!ability.effect || hasEffect(target, ability.effect)) return '';
      addEffect(target, ability.effect, false);
      return ` — ${target.name} is ${CONDITION_LABELS[ability.effect].toLowerCase()}`;
    };

    if (ability.type === 'save') {
      // One damage roll for the whole area (5e), one save per creature.
      openSave(key, combat, c, {
        name: ability.name, verb: 'uses', note: spent, aim,
        saveAbility: ability.saveAbility, dc: ability.dc, saveSuccess: ability.saveSuccess,
        damage: ability.damage, damageType: ability.damageType, effect: ability.effect
      }, targets, stagedCharacterHP, rollsSaveNow);
    } else if (ability.type === 'attack') {
      targets.forEach((target, index) => {
        const sight = sightModifiers(key, c, target);
        const roll = rollD20(payload.advantage === true || sight.advantage, hasEffect(target, 'dodging') || sight.disadvantage);
        const crit = roll.used === 20;
        const total = roll.used + ability.attack;
        const hit = roll.used !== 1 && (crit || total >= target.ac);
        let text = `${c.name} uses ${ability.name}${index === 0 ? spent : ''} on ${target.name}${sight.note}: d20 ${roll.text} ${fmtSigned(ability.attack)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
        const entry = {
          kind: 'attack', actorName: c.name, targetName: target.name,
          roll: { d20: roll.d20, used: roll.used, mod: ability.attack, total, vs: target.ac, hit, crit, disadvantage: roll.mode < 0, advantage: roll.mode > 0 }
        };
        if (hit) {
          if (ability.damage) {
            const dmg = rollDamage(ability.damage, crit);
            entry.dmg = dmg;
            text += ` · ${dmg.expr}${crit ? ' (crit ×2 dice)' : ''} → ${dmg.total}${ability.damageType ? ' ' + ability.damageType : ''}`;
            const next = applyDamageToTarget(target, dmg.total, stagedCharacterHP);
            if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
          }
          text += applyEffect(target);
        }
        entry.text = text;
        entry.fx = combatFx(c, target, ability.name, ability.damageType, hit);
        pushLog(key, combat, entry);
      });
    } else if (ability.type === 'heal') {
      const amount = rollDamage(ability.damage || '0', false);
      for (const target of (targets.length ? targets : [c])) {
        const before = (target.hp && typeof target.hp.current === 'number') ? target.hp.current : target.maxHP;
        const next = applyHealToTarget(target, amount.total, stagedCharacterHP);
        pushLog(key, combat, {
          kind: 'action', actorName: c.name, targetName: target.name,
          dmg: { expr: amount.expr, rolls: amount.rolls, total: amount.total },
          text: `${c.name} uses ${ability.name}${spent} on ${target === c ? 'themself' : target.name}: ${amount.expr} → ${amount.total} healed (${before} → ${next == null ? before : next} HP)`
        });
      }
    } else {
      const notes = [];
      if (ability.selfEffect) {
        addEffect(c, ability.selfEffect, false);
        notes.push(CONDITION_LABELS[ability.selfEffect].toLowerCase());
      }
      for (const target of targets) { const note = applyEffect(target); if (note) notes.push(note.replace(/^ — /, '')); }
      if (ability.grant === 'dash') {
        c.dashFeet += c.speedFeet; addEffect(c, 'dashed', true);
        notes.push(`+${c.speedFeet} ft movement`);
      } else if (ability.grant === 'dodge') {
        addEffect(c, 'dodging', true); notes.push('attacks against them at disadvantage');
      } else if (ability.grant === 'disengage') {
        addEffect(c, 'disengaged', true); notes.push('disengaged');
      } else if (ability.grant === 'attacks') {
        c.bonusAttacks = { count: ability.grantCount || 1, only: ability.grantAttack || '' };
        notes.push(`${c.bonusAttacks.count} extra ${c.bonusAttacks.only || 'weapon'} attack(s)`);
      } else if (ability.grant === 'action') {
        c.actionUsed = false; c.attacksLeft = 0;
        notes.push('one more action this turn');
      }
      pushLog(key, combat, {
        kind: 'action', actorName: c.name,
        fx: combatFx(c, null, ability.name),
        text: `${c.name} uses ${ability.name}${spent}${notes.length ? ' — ' + notes.join(', ') : ''}`
      });
    }
    return null;
  }

  onCampaign('combat-action', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !combat.started || !payload) return;
    const c = ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (combat.activeId !== c.id) return combatDeny("Not this combatant's turn");
    if (hasEffect(c, 'down')) return combatDeny(`${c.name} is down`);
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
    const kind = String(payload.kind || '');
    const actionSpent = () => combatDeny('Action already used this turn');
    if (kind === 'dash') {
      if (c.actionUsed) return actionSpent();
      c.dashFeet += c.speedFeet;
      addEffect(c, 'dashed', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} dashes (+${c.speedFeet} ft movement)` });
      c.actionUsed = true; c.attacksLeft = 0;
    } else if (kind === 'dodge') {
      if (c.actionUsed) return actionSpent();
      addEffect(c, 'dodging', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} takes the Dodge action (attacks against them at disadvantage)` });
      c.actionUsed = true; c.attacksLeft = 0;
    } else if (kind === 'disengage') {
      if (c.actionUsed) return actionSpent();
      addEffect(c, 'disengaged', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} disengages` });
      c.actionUsed = true; c.attacksLeft = 0;
    } else if (kind === 'attack') {
      const target = ownValue(combat.combatants, payload.targetId);
      if (!target) return combatDeny('No such target');
      if (target.id === c.id) return combatDeny("Can't target yourself");
      const atk = c.attacks[clampInt(payload.attackIndex, 0, 99, -1)];
      if (!atk) return combatDeny('No such attack');
      // Where does this swing come from? The Attack action, an Extra Attack
      // left over from it, or a strike granted by a bonus action.
      const granted = c.bonusAttacks && c.bonusAttacks.count > 0 &&
        (!c.bonusAttacks.only || atk.name.toLowerCase().includes(c.bonusAttacks.only.toLowerCase()));
      if (!c.actionUsed) {
        c.actionUsed = true;
        c.attacksLeft = Math.max(0, (c.attacksPerAction || 1) - 1);
      } else if (c.attacksLeft > 0) {
        c.attacksLeft -= 1;
      } else if (granted) {
        c.bonusAttacks.count -= 1;
        if (c.bonusAttacks.count <= 0) c.bonusAttacks = null;
      } else {
        return actionSpent();
      }
      resolveWeaponAttack(key, combat, c, target, atk, payload, stagedCharacterHP);
    } else if (kind === 'strike') {
      // A summoned weapon attacks a creature within 5 ft of it: free on the
      // turn it was cast (part of the casting), a bonus action afterwards.
      const weapon = ownValue(getMap(key).objects, boundedText(payload.summonId, 80));
      if (!weapon || weapon.type !== 'summon' || weapon.casterId !== c.id || !isRecord(weapon.strike)) return combatDeny('Nothing to strike with');
      const target = ownValue(combat.combatants, payload.targetId);
      const targetObject = target && ownValue(getMap(key).objects, target.id);
      if (!target || !targetObject || !targetObject.position) return combatDeny('No such target');
      if (hasEffect(target, 'down')) return combatDeny(`${target.name} is down`);
      if (Math.hypot(targetObject.position.x - weapon.position.x, targetObject.position.z - weapon.position.z) * 5 > 7.6) {
        return combatDeny(`${target.name} is not within 5 ft of ${weapon.name}: move it first`);
      }
      const turn = `${combat.round}:${c.id}`;
      if (weapon.castTurn === turn && weapon.struck !== turn) weapon.struck = turn;
      else if (c.bonusUsed) return combatDeny('Bonus action already used this turn');
      else c.bonusUsed = true;
      const roll = rollD20(payload.advantage === true, hasEffect(target, 'dodging'));
      const crit = roll.used === 20;
      const atk = poolInt(weapon.strike.atk, -10, 30, 0);
      const total = roll.used + atk;
      const hit = roll.used !== 1 && (crit || total >= target.ac);
      let text = `${c.name}'s ${weapon.name} strikes at ${target.name}: d20 ${roll.text} ${fmtSigned(atk)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
      const entry = { kind: 'cast', actorName: c.name, targetName: target.name, spellName: weapon.name, roll: { d20: roll.d20, used: roll.used, mod: atk, total, vs: target.ac, hit, crit, disadvantage: roll.mode < 0 } };
      if (hit) {
        const dmg = rollDamage(weapon.strike.damage, crit);
        entry.dmg = dmg;
        text += ` · ${dmg.expr}${crit ? ' (crit ×2 dice)' : ''} → ${dmg.total} ${weapon.strike.damageType || 'force'}`;
        if (applyDamageToTarget(target, dmg.total, stagedCharacterHP) === 0) text += ` — ${target.name} drops to 0 HP!`;
      }
      entry.fx = { actor: weapon.id, target: target.id, action: weapon.name, type: weapon.strike.damageType || 'force', landed: hit, form: 'touch' };
      entry.text = text; pushLog(key, combat, entry);
    } else if (kind === 'ability') {
      const ability = (c.abilities || [])[clampInt(payload.abilityIndex, 0, 99, -1)];
      if (!ability) return combatDeny('No such ability');
      const problem = resolveAbility(key, combat, c, ability, payload, stagedCharacterHP);
      if (problem) return combatDeny(problem);
    } else if (kind === 'cast' && isRecord(payload.utility)) {
      // A spell with no damage the tracker can apply (a buff, a wall, a
      // charm): it costs its action and its slot, the effect is the table's.
      const name = boundedString(payload.utility.name, 40) || 'a spell';
      const level = clampInt(payload.utility.level, 0, 9, 0);
      const bonus = payload.utility.time === 'bonus';
      if (bonus ? c.bonusUsed : c.actionUsed) return combatDeny(bonus ? 'Bonus action already used this turn' : 'Action already used this turn');
      let castLevel = 0;
      if (level > 0) {
        castLevel = takeCombatSlot(c, level, payload.slotLevel);
        if (!castLevel) return combatDeny(`No spell slots left for ${name}`);
      }
      if (bonus) c.bonusUsed = true; else { c.actionUsed = true; c.attacksLeft = 0; }
      if (payload.utility.concentration === true) beginConcentration(key, combat, c, name, clampInt(payload.utility.rounds, 1, 14400, 0));
      const detail = boundedString(payload.utility.note, 200);
      pushLog(key, combat, {
        kind: 'action', actorName: c.name, fx: combatFx(c, null, name),
        text: `${c.name} casts ${name}${castLevel > level ? ` with a level ${castLevel} slot` : ''}${bonus ? ' (bonus action)' : ''}${detail ? ' — ' + detail : ''}`
      });
    } else if (kind === 'cast') {
      const spell = c.spells && c.spells[clampInt(payload.spellIndex, 0, 19, -1)];
      if (!spell) return combatDeny('No such spell');
      const quick = spell.time === 'bonus'; // Healing Word: a bonus action, the action stays
      if (quick ? c.bonusUsed : c.actionUsed) return quick ? combatDeny('Bonus action already used this turn') : actionSpent();
      // A spell with an area is aimed at a point; the server says who is in it.
      const shape = aoe.normalizeShape({ kind: spell.area, sizeFt: spell.areaFt, rangeFt: spell.area === 'sphere' || spell.area === 'cylinder' || spell.area === 'cube' ? spell.rangeFt : 0 });
      const buff = !spell.attackType && !spell.saveAbility; // no roll: it simply lands on whoever is picked
      const aimed = !!spell.saveAbility && (aoe.shapeNeedsPoint(shape) || (shape.kind === 'self' && shape.sizeFt > 0));
      let area = null;
      if (aimed) {
        if (shape.kind !== 'self' && !isRecord(payload.aim)) return combatDeny(`Aim ${spell.name} first`);
        area = areaTargets(key, combat, c, shape, payload.aim);
        if (typeof area === 'string') return combatDeny(area);
      }
      const target = aimed || buff ? null : ownValue(combat.combatants, payload.targetId);
      let friends = null;
      if (buff) {
        const ids = Array.isArray(payload.targetIds) ? payload.targetIds : [payload.targetId];
        friends = [...new Set(ids.slice(0, 24).map(id => boundedText(id, 80)).filter(Boolean))]
          .map(id => ownValue(combat.combatants, id)).filter(Boolean).slice(0, spell.maxTargets || 1);
        if (!friends.length) friends = [c]; // nobody picked: the caster
      } else if (!aimed) {
        if (!target) return combatDeny('No such target');
        if (target.id === c.id) return combatDeny("Can't target yourself");
        if (hasEffect(target, 'down')) return combatDeny(`${target.name} is down`);
      }
      let castLevel = spell.level;
      if (spell.level > 0) {
        castLevel = takeCombatSlot(c, spell.level, payload.slotLevel); // a miss still spends the slot (5e)
        if (!castLevel) return combatDeny(`No level ${spell.level} spell slots left`);
      }
      const spellDamage = (spell.bySlot && spell.bySlot[castLevel]) || spell.damage;
      const upcastNote = castLevel > spell.level ? ` (level ${castLevel} slot)` : '';
      if (spell.concentration) beginConcentration(key, combat, c, spell.name, spell.rounds || 0);
      if (spell.summon) {
        // Set down at the point aimed at (beside the caster when none is given).
        const me = ownValue(getMap(key).objects, c.id);
        const point = castPoint(payload.aim);
        const reach = spell.rangeFt || 5;
        const at = me && me.position ? (point || { x: me.position.x + 1, z: me.position.z }) : null;
        const tooFar = at && Math.hypot(at.x - me.position.x, at.z - me.position.z) * 5 > reach + 2.5;
        const soles = at ? me.position.y - (me.type === 'character' ? CHARACTER_SOLE_DEPTH : TOKEN_SOLE_DEPTH) : 0;
        const made = at && !tooFar && conjure(key, {
          ...spell.summon, spell: spell.name, owner: c.owner || '', charId: c.charId || '',
          casterId: c.id, casterName: c.name, held: spell.concentration === true, color: c.color,
          position: { x: at.x, y: groundY(key, at.x, at.z, soles), z: at.z },
          castTurn: `${combat.round}:${c.id}`,
          ...(spell.rounds && !spell.concentration ? { until: combat.round + spell.rounds } : {}),
          ...(spell.summon.strike ? { strike: { atk: c.spellAtk, damage: spellDamage || '1d8', damageType: spell.damageType || 'force' } } : {})
        });
        if (!made) {
          restoreCombatField(getMap(key), previousCombat);
          flushSummonChanges();
          return combatDeny(!at ? `${c.name} has no token on the map` : tooFar ? `${spell.name} reaches ${reach} ft` : 'Object limit reached');
        }
        pushLog(key, combat, {
          kind: 'cast', actorName: c.name, spellName: spell.name,
          fx: { ...combatFx(c, null, spell.name, spell.damageType), form: 'aura', landed: true },
          text: `${c.name} casts ${spell.name}${upcastNote}${quick ? ' (bonus action)' : ''}${spell.summon.strike ? ' — it may strike once this turn' : ''}${spell.concentration ? ' (concentration)' : ''}`
        });
      } else if (buff) {
        const outcome = [];
        let healed = null;
        if (spell.heal) { // one roll, given to everyone picked
          healed = rollDamage((spell.bySlot && spell.bySlot[castLevel]) || spell.heal, false);
          outcome.push(`${healed.expr} → ${healed.total} healed`);
        }
        for (const friend of friends) {
          if (healed) {
            const before = friend.hp && typeof friend.hp.current === 'number' ? friend.hp.current : friend.maxHP;
            const after = applyHealToTarget(friend, healed.total, stagedCharacterHP);
            if (friends.length > 1 || after - before !== healed.total) outcome.push(`${friend.name} ${before} → ${after} HP`);
          }
          if (spell.effect) {
            addEffect(friend, spell.effect, false);
            if (spell.concentration) holdEffect(c, friend, spell.effect);
          }
          if (spell.light && setSpellLight(key, friend.id, vision.normalizeLight(spell.light)) && isRecord(c.concentration) && spell.concentration) {
            c.concentration.lights = [...(c.concentration.lights || []), friend.id].slice(-12);
          }
        }
        if (spell.effect) outcome.push(CONDITION_LABELS[spell.effect].toLowerCase());
        if (spell.light) outcome.push(spell.light.dark ? `magical darkness, ${spell.light.dark} ft` : `light, ${spell.light.bright + spell.light.dim} ft`);
        const alone = friends.length === 1 ? friends[0] : null;
        pushLog(key, combat, {
          kind: 'cast', actorName: c.name, spellName: spell.name,
          ...(healed ? { dmg: healed } : {}),
          fx: {
            ...combatFx(c, null, spell.name), targets: friends.map(friend => friend.id),
            form: spell.form || (healed ? 'heal' : 'aura'), landed: true
          },
          text: `${c.name} casts ${spell.name}${upcastNote}${quick ? ' (bonus action)' : ''} on ${alone === c ? 'themself' : friends.map(friend => friend.name).join(', ')} — ${outcome.join(', ')}${spell.concentration ? ' (concentration)' : ''}`
        });
      } else if (spell.attackType) { // attack-roll spell (spellAtk vs AC)
        const sight = sightModifiers(key, c, target);
        const roll = rollD20(payload.advantage === true || sight.advantage, hasEffect(target, 'dodging') || sight.disadvantage);
        const { d20, used } = roll;
        const disadvantage = roll.mode < 0;
        const crit = used === 20;
        const total = used + c.spellAtk;
        const hit = used !== 1 && (crit || total >= target.ac);
        let text = `${c.name} casts ${spell.name} at ${target.name}${sight.note}: d20 ${roll.text} ${fmtSigned(c.spellAtk)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
        const entry = { kind: 'cast', actorName: c.name, targetName: target.name, spellName: spell.name, roll: { d20, used, mod: c.spellAtk, total, vs: target.ac, hit, crit, disadvantage } };
        if (hit) {
          const dmg = rollDamage(spellDamage, crit);
          entry.dmg = dmg;
          text += ` · ${dmg.expr}${crit ? ' (crit ×2 dice)' : ''} → ${dmg.total}${spell.damageType ? ' ' + spell.damageType : ''}`;
          const next = applyDamageToTarget(target, dmg.total, stagedCharacterHP);
          if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
        }
        entry.fx = { ...combatFx(c, target, spell.name, spell.damageType, hit), form: spell.form || (spell.attackType === 'melee' ? 'touch' : 'bolt') };
        entry.text = text; pushLog(key, combat, entry);
      } else if (spell.zone && area && !spell.zone.initial) {
        // It only lingers: nobody saves until they start a turn in it or walk in.
        pushLog(key, combat, {
          kind: 'cast', actorName: c.name, spellName: spell.name,
          fx: { ...combatFx(c, null, spell.name, spell.damageType), area: areaFx(area.aim) },
          text: `${c.name} casts ${spell.name}${upcastNote} — the area stays (DC ${c.spellDC} ${spell.saveAbility.toUpperCase()}${spellDamage ? `, ${spellDamage}${spell.damageType ? ' ' + spell.damageType : ''}` : ''})${spell.concentration ? ' (concentration)' : ''}`
        });
      } else { // save-for-half/none spell: one damage roll, a save per creature
        openSave(key, combat, c, {
          name: spell.name, verb: 'casts', note: upcastNote, aim: area ? area.aim : null,
          saveAbility: spell.saveAbility, dc: c.spellDC, saveSuccess: spell.saveSuccess,
          damage: spellDamage, damageType: spell.damageType, form: spell.form,
          effect: spell.effect, linked: spell.concentration === true
        }, area ? area.targets : [target], stagedCharacterHP, rollsSaveNow);
      }
      if (spell.zone && area) {
        const fx = areaFx(area.aim);
        const at = (pair) => ({ x: pair[0], z: pair[1] });
        dropZones(combat, zone => !(zone.sourceId === c.id && zone.name === spell.name)); // cast again: it moves
        combat.zones = [...(Array.isArray(combat.zones) ? combat.zones : []), {
          id: crypto.randomUUID().slice(0, 8), sourceId: c.id, sourceName: c.name, name: spell.name,
          aim: { kind: fx.kind, size: fx.size, width: fx.width, origin: at(fx.origin), center: at(fx.center), dir: at(fx.dir) },
          on: spell.zone.on, saveAbility: spell.saveAbility, dc: c.spellDC, saveSuccess: spell.saveSuccess,
          damage: spellDamage || '', damageType: spell.damageType || '',
          ...(spell.effect ? { effect: spell.effect } : {}),
          ...(spell.zone.follow ? { follow: true } : {}),
          ...(spell.concentration ? { held: true } : {}),
          ...(spell.rounds && !spell.concentration ? { until: combat.round + spell.rounds } : {}),
          // Whoever saved as it was cast is not caught again this turn.
          touched: spell.zone.initial ? area.targets.map(target => target.id) : []
        }].slice(-12);
      }
      if (quick) c.bonusUsed = true; else { c.actionUsed = true; c.attacksLeft = 0; }
    } else {
      return;
    }
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  // Roll a saving throw that is waiting: { pendingId?, combatantId? } — one
  // creature's save, or (ids left out) every save this user may roll. A player
  // rolls for their own characters, the GM for anyone.
  onCampaign('combat-save', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !Array.isArray(combat.pending) || !combat.pending.length) return;
    const wanted = isRecord(payload) ? payload : {};
    const pendingId = boundedText(wanted.pendingId, 24);
    const combatantId = boundedText(wanted.combatantId, 80);
    const mine = [];
    for (const pending of combat.pending) {
      if (pendingId && pending.id !== pendingId) continue;
      for (const [id, state] of Object.entries(pending.targets)) {
        const target = ownValue(combat.combatants, id);
        if (!target || state.done || (combatantId && id !== combatantId)) continue;
        if (canControl(target)) mine.push([pending, target]);
      }
    }
    if (!mine.length) return combatDeny('No saving throw of yours is waiting');
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
    for (const [pending, target] of mine) resolvePendingSave(key, combat, pending, target, stagedCharacterHP);
    prunePending(combat);
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  // Dismiss an area that lingers: its caster's player, or the GM.
  onCampaign('combat-zone', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const id = isRecord(payload) ? boundedText(payload.id, 24) : '';
    const zone = combat && (combat.zones || []).find(other => other.id === id);
    if (!zone) return;
    const source = ownValue(combat.combatants, zone.sourceId);
    if (!isCampaignGM(socket.username) && !(source && canControl(source))) return combatDeny('Not your spell');
    const previousCombat = snapshotField(getMap(key), 'combat');
    dropZones(combat, other => other !== zone);
    pushLog(key, combat, { kind: 'info', actorName: zone.sourceName, text: `${zone.sourceName}'s ${zone.name} is gone` });
    persistCombat(key, previousCombat);
  });

  // Let go of the spell being concentrated on (no action; owner or GM).
  onCampaign('combat-concentration', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && isRecord(payload) && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (!isRecord(c.concentration)) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    endConcentration(key, combat, c, 'stops concentrating');
    persistCombat(key, previousCombat);
  });

  onCampaign('combat-end-turn', () => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !combat.started) return;
    const active = combat.activeId && ownValue(combat.combatants, combat.activeId);
    const gm = isCampaignGM(socket.username);
    if (!gm && !(active && active.owner === socket.username)) return combatDeny('Not your turn');
    // The turn waits for the saves it caused; the GM moving on rolls them.
    if (!gm && Array.isArray(combat.pending) && combat.pending.length) return combatDeny('Saving throws are still being rolled');
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
    settlePending(key, combat, stagedCharacterHP);
    advanceTurn(key, combat);
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  onCampaign('combat-set-turn', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && combat.started && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
    settlePending(key, combat, stagedCharacterHP);
    startTurn(key, combat, c.id);
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  onCampaign('combat-update-combatant', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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
    if (isRecord(patch.resources)) {
      for (const [resourceKey, current] of Object.entries(patch.resources)) {
        const resource = ownValue(c.resources, resourceKey);
        if (resource) resource.current = clampInt(current, 0, resource.max, resource.current);
      }
    }
    if (patch.hpCurrent != null) {
      const v = clampInt(patch.hpCurrent, 0, 999, 0);
      const had = c.hp && typeof c.hp.current === 'number' ? c.hp.current : c.maxHP;
      if (v < had && isRecord(c.concentration)) c.concHits = [had - v];
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

  onCampaign('combat-set-order', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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

  onCampaign('combat-remove-combatant', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    removeCombatant(key, combat, c.id);
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} leaves the fight` });
    persistCombat(key, previousCombat);
  });

  onCampaign('combat-add-combatant', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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

  onCampaign('combat-effect', (payload) => {
    if (!isCampaignGM(socket.username)) return combatDeny('GM only');
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

  onCampaign('add-ruler', (data) => {
    if (!socket.username || !isRecord(data) || !Array.isArray(data.points)) return;
    if (data.points.length < 2 || data.points.length > MAX_RULER_POINTS || serializedBytes(data) > 64 * 1024) return;
    const points = data.points.map(sanitizePosition);
    if (points.some(point => !point)) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = ownValue(maps, key) || (isCampaignGM(socket.username) ? getMap(key) : null);
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
    io.to(mapRoom(activeCampaignId(), key)).emit('ruler-added', newRuler);
  });

  onCampaign('clear-rulers', () => {
    if (!socket.username) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = ownValue(maps, key) || (isCampaignGM(socket.username) ? getMap(key) : null);
    if (!map) return;
    const previousRulers = snapshotField(map, 'rulers');
    map.rulers = {};
    if (!saveMaps()) {
      restoreField(map, 'rulers', previousRulers);
      socket.emit('error', 'Could not clear the rulers');
      return;
    }
    io.to(mapRoom(activeCampaignId(), key)).emit('rulers-cleared');
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
  onCampaign('reset-terrain', (payload) => {
    const requestId = sanitizeStructureIdentity(payload && payload.requestId);
    const reject = (reason) => socket.emit('terrain-reset-rejected', { requestId, reason });
    if (!isCampaignGM(socket.username)) { reject('GM only'); return; }
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
      io.to(mapRoom(activeCampaignId(), key)).emit('terrain-reset-applied', result);
      return;
    }
    emitToUnified(null, (recipient) => {
      if (isCampaignGM(recipient.username)) {
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

  onCampaign('update-terrain', (data) => {
    if (!isCampaignGM(socket.username)) { socket.emit('error', 'GM only'); return; }
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
      socket.to(mapRoom(activeCampaignId(), key)).emit('terrain-updated', accepted);
      return;
    }
    // Fog of war: players only receive chunk edits inside revealed hexes.
    emitToRoom(key, socket, (sock) => {
      if (isCampaignGM(sock.username)) { sock.emit('terrain-updated', accepted); return; }
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
  onCampaign('update-fog', (payload) => {
    if (!isCampaignGM(socket.username)) return;
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
    io.to(campRoom(activeCampaignId())).emit('fog-updated', { hexes: changed, revealed });
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
      if (!sock.username || isCampaignGM(sock.username) || !isUnifiedKey(sock.currentMapKey || '')) continue;
      const m = getMap(WORLD_KEY);
      for (const obj of Object.values(m.objects)) {
        if (ownsObject(sock.username, obj)) continue; // visible either way
        const p = obj.position || {};
        if (!changedSet.has(fogHexKeyAt(Number(p.x) || 0, Number(p.z) || 0))) continue;
        // Creatures also answer to token vision: reconcileVision below
        // decides them from both the fog and the sight rules.
        if (vision.isCreature(obj)) continue;
        if (revealed) { if (obj.hidden !== true) sock.emit('object-added', projectObjectFor(sock.username, obj)); }
        else sock.emit('object-deleted', { id: obj.id });
      }
      if (chunkDelta) sock.emit('terrain-updated', { chunks: chunkDelta });
    }
    reconcileVision(WORLD_KEY);
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
      if (sock === socket || !sock.username || isCampaignGM(sock.username)) continue;
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
  onCampaign('camera-command', (payload) => {
    if (!isCampaignGM(socket.username)) return;
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
  onCampaign('camera-release', (payload) => {
    if (!isCampaignGM(socket.username)) return;
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

// A cycling clock changes the light with no event to hang a reconcile on:
// sweep the campaigns that have vision on and someone at the table.
setInterval(() => {
  const active = new Set();
  for (const sock of io.sockets.sockets.values()) if (sock.campaignId) active.add(sock.campaignId);
  for (const id of active) {
    const campaign = campaignById(id);
    const settings = campaign && campaign.settings;
    if (!settings || !settings.vision || !settings.vision.enabled || settings.sky.clock !== 'cycle') continue;
    const store = storeFor(id);
    if (store) withStore(store, () => reconcileCampaignVision());
  }
}, 20000).unref();

sharedModulesReady.then(() => server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`========================================`);
  console.log(`VTT Server Running`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Network: http://${localIP}:${PORT}`);
  console.log(`========================================`);
  console.log(`Home: /`);
  console.log(`Character Creator: /creator`);
  console.log(`GM Screen: /gm`);
  console.log(`Player Screen: /player`);
  console.log(`========================================`);
})).catch((error) => {
  console.error('[BOOT] Could not load the shared vision modules:', error);
  process.exit(1);
});
