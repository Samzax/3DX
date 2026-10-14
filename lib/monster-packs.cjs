// Monster model packs: optional, uncommitted data packs that override the
// committed monster manifest with richer (usually animated) GLB models.
//
// A pack is a folder under data/packs/ (or THREEDX_PACKS_DIR):
//
//   data/packs/<packId>/pack.json
//   data/packs/<packId>/*.glb
//
// pack.json:
//   {
//     "name": "Dragons",
//     "templates": {                       // optional, shared by many monsters
//       "red": { "file": "red-dragon.glb", "animations": "dragon-clips.glb",
//                "clips": { "idle": "Idle", "bite": "Bite", "breath": "Breath" },
//                "breath": { "socket": "Mouth", "shape": "cone" } }
//     },
//     "monsters": {
//       "adult-red-dragon":  { "template": "red", "height": 3.4 },
//       "red-dragon-wyrmling": { "template": "red", "height": 1.1,
//                                "proportions": { "Head": 1.3, "Wing.L": 0.8 } }
//     }
//   }
//
// Every field is sanitized here, once, on the server: the client only ever sees
// entries built by sanitizeEntry (kind:'gltf' + url under /packs/). A broken
// pack or entry is skipped with a warning — the committed manifest entry (the
// procedural model) keeps rendering, so a checkout without packs is unaffected.

const fs = require('node:fs');
const path = require('node:path');

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MONSTER_INDEX_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MODEL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.glb$/;
const NAME_RE = /^[^\u0000-\u001f<>"'`\\]{1,64}$/; // clip / bone / action names
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const BREATH_SHAPES = new Set(['cone', 'line']);
// Roles the client animation runtime understands (monster-anim.js CLIP_ROLES).
const ACTION_ROLES = ['attack', 'bite', 'claw', 'tail', 'wing', 'breath', 'roar', 'hit'];
const CLIP_ROLES = new Set([
  'idle', 'walk', 'fly', ...ACTION_ROLES, 'death', 'talk',
  ...ACTION_ROLES.map(role => `fly_${role}`) // airborne variants, used while 'flying'
]);
const MAX_MAP_KEYS = 64;

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanName = value => (typeof value === 'string' && NAME_RE.test(value.trim()) ? value.trim() : null);

function boundedNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

// role -> clip name. Unknown roles are dropped (they could never be played).
function sanitizeClips(raw) {
  if (!isRecord(raw)) return null;
  const clips = {};
  for (const [role, name] of Object.entries(raw).slice(0, MAX_MAP_KEYS)) {
    const clip = cleanName(name);
    if (CLIP_ROLES.has(role) && clip) clips[role] = clip;
  }
  return Object.keys(clips).length ? clips : null;
}

// Combat action name (as the stat block spells it) -> role. Keys are stored
// lower-case so the client can match case-insensitively.
function sanitizeActions(raw) {
  if (!isRecord(raw)) return null;
  const actions = {};
  for (const [name, role] of Object.entries(raw).slice(0, MAX_MAP_KEYS)) {
    const action = cleanName(name);
    if (action && CLIP_ROLES.has(role)) actions[action.toLowerCase()] = role;
  }
  return Object.keys(actions).length ? actions : null;
}

// bone name -> uniform scale: the growth-stage presets (one sculpt, four ages).
function sanitizeProportions(raw) {
  if (!isRecord(raw)) return null;
  const proportions = {};
  for (const [name, value] of Object.entries(raw).slice(0, MAX_MAP_KEYS)) {
    const bone = cleanName(name);
    const scale = boundedNumber(value, 0.2, 5);
    if (bone && scale != null) proportions[bone] = scale;
  }
  return Object.keys(proportions).length ? proportions : null;
}

function sanitizeBreath(raw) {
  if (!isRecord(raw)) return null;
  const breath = {};
  const socket = cleanName(raw.socket);
  if (socket) breath.socket = socket;
  if (BREATH_SHAPES.has(raw.shape)) breath.shape = raw.shape;
  if (typeof raw.color === 'string' && COLOR_RE.test(raw.color)) breath.color = raw.color.toLowerCase();
  const at = boundedNumber(raw.at, 0, 10); // seconds into the breath clip the stream starts
  if (at != null) breath.at = at;
  return Object.keys(breath).length ? breath : null;
}

function sanitizeEntry(packId, packDir, index, raw, base) {
  if (!isRecord(raw)) return { error: 'entry is not an object' };
  if (typeof raw.file !== 'string' || !MODEL_FILE_RE.test(raw.file)) return { error: 'missing or invalid "file" (a .glb name inside the pack folder)' };
  if (!fs.existsSync(path.join(packDir, raw.file))) return { error: `file not found: ${raw.file}` };
  const height = boundedNumber(raw.height, 0.05, 20) ?? boundedNumber(base && base.height, 0.05, 20);
  if (height == null) return { error: 'missing "height" (0.05–20 world units)' };

  const entry = {
    index,
    kind: 'gltf',
    plan: base && typeof base.plan === 'string' ? base.plan : 'pack',
    pack: packId,
    url: `/packs/${packId}/${raw.file}`,
    height
  };
  const nameplateY = boundedNumber(raw.nameplateY, 0.72, 20);
  if (nameplateY != null) entry.nameplateY = nameplateY;
  if (typeof raw.animations === 'string' && MODEL_FILE_RE.test(raw.animations)) {
    if (!fs.existsSync(path.join(packDir, raw.animations))) return { error: `file not found: ${raw.animations}` };
    entry.animUrl = `/packs/${packId}/${raw.animations}`;
  }
  const clips = sanitizeClips(raw.clips);
  if (clips) entry.clips = clips;
  const actions = sanitizeActions(raw.actions);
  if (actions) entry.actions = actions;
  const proportions = sanitizeProportions(raw.proportions);
  if (proportions) entry.proportions = proportions;
  const breath = sanitizeBreath(raw.breath);
  if (breath) entry.breath = breath;
  // Multiplies the base colour: age stages of one sculpt (a darker ancient, etc.).
  if (typeof raw.tint === 'string' && COLOR_RE.test(raw.tint)) entry.tint = raw.tint.toLowerCase();
  return { entry };
}

// Read every pack under `dir`. `baseMonsters` is the committed manifest's
// monsters map (entries inherit its plan/height). Returns
// { entries: { index -> entry }, packs: [{ id, name, count }], warnings: [] };
// later packs (alphabetical) win when two packs claim the same monster.
function loadMonsterPacks(dir, baseMonsters = {}) {
  const result = { entries: Object.create(null), packs: [], warnings: [] };
  let folders;
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return result; // no packs folder: the normal case
  }
  for (const folder of folders.filter(item => item.isDirectory()).map(item => item.name).sort()) {
    const packDir = path.join(dir, folder);
    const jsonPath = path.join(packDir, 'pack.json');
    if (!fs.existsSync(jsonPath)) continue;
    if (!PACK_ID_RE.test(folder)) {
      result.warnings.push(`${folder}: folder name must be lower-case letters, digits, - or _`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (error) {
      result.warnings.push(`${folder}: pack.json is not valid JSON (${error.message})`);
      continue;
    }
    if (!isRecord(json) || !isRecord(json.monsters)) {
      // A characters-only pack (lib/character-packs.cjs) is not a mistake.
      if (!isRecord(json) || !isRecord(json.characters)) {
        result.warnings.push(`${folder}: pack.json needs a "monsters" or "characters" object`);
      }
      continue;
    }
    const templates = isRecord(json.templates) ? json.templates : {};
    let count = 0;
    for (const [rawIndex, rawEntry] of Object.entries(json.monsters)) {
      const index = String(rawIndex).toLowerCase();
      if (!MONSTER_INDEX_RE.test(index)) {
        result.warnings.push(`${folder}: invalid monster index "${rawIndex}"`);
        continue;
      }
      const template = isRecord(rawEntry) && typeof rawEntry.template === 'string'
        ? (Object.prototype.hasOwnProperty.call(templates, rawEntry.template) ? templates[rawEntry.template] : undefined)
        : null;
      if (template === undefined || (template !== null && !isRecord(template))) {
        result.warnings.push(`${folder}/${index}: unknown template "${rawEntry.template}"`);
        continue;
      }
      const base = Object.prototype.hasOwnProperty.call(baseMonsters, index) ? baseMonsters[index] : null;
      const { entry, error } = sanitizeEntry(folder, packDir, index, { ...(template || {}), ...rawEntry }, base);
      if (error) {
        result.warnings.push(`${folder}/${index}: ${error}`);
        continue;
      }
      result.entries[index] = entry;
      count += 1;
    }
    result.packs.push({ id: folder, name: typeof json.name === 'string' ? json.name.slice(0, 80) : folder, count });
  }
  return result;
}

module.exports = { loadMonsterPacks, CLIP_ROLES };
