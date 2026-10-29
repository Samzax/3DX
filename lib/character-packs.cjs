// Character model packs: optional, uncommitted "looks" — whole character
// models (generated with 3DGen / ComfyUI / Meshy / Tripo, sculpted, bought…)
// a player can pick in the creator instead of the built-in dressed base body.
//
// A pack is the same folder monster packs use (data/packs/<packId>/, or
// THREEDX_PACKS_DIR); one pack.json may carry "monsters", "characters" or both:
//
//   {
//     "name": "Heroes",
//     "characters": {
//       "ranger-f": {
//         "name": "Wood elf ranger",       // shown in the creator gallery
//         "file": "ranger-f.glb",          // any GLB; rigged or a static figure
//         "height": 1.1,                   // world units (1u = 5 ft); default 1.15
//         "races": ["elf", "half-elf"],    // optional: only offered to these races (SRD index, or a homebrew race's name)
//         "body": "female",                // optional gallery filter
//         "animations": "ranger-clips.glb",// optional: clips in a separate file
//         "clips": { "idle": "Idle", "walk": "Walk", "attack": "Slash" },
//         "thumb": "ranger-f.png",         // optional gallery thumbnail
//         "toon": true,                    // optional: cartoon rendering, flat unlit colours + ink outline
//         "outline": 1                     // optional with toon: outline weight, 0 (none) to 3
//       }
//     }
//   }
//
// Clip roles: idle, walk, attack, cast, hit, death, talk, plus "heavy" (the swing for a prop whose
// "attack" is "heavy") and "carry_idle" / "carry_walk" (played instead while a prop is in hand).
//
// "props" are things held in the hand, for any character (kit body or look), shown when the sheet's
// first equipped weapon is one of the listed items (item indices, SRD or homebrew):
//
//     "props": {
//       "mallet": {
//         "name": "Mallet",
//         "file": "mallet.glb",            // grip at the origin, handle along +Y
//         "length": 0.95,                  // world units along +Y; default 0.6
//         "items": ["mallet"],
//         "attack": "heavy"                // optional: its attacks play the "heavy" role
//       }
//     }
//
// A look with no "clips" stands as a static miniature. Everything is sanitized
// here, once; a broken entry is skipped with a warning and characters that
// reference a look this server doesn't have fall back to the base body.

const fs = require('node:fs');
const path = require('node:path');

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const LOOK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
// What a saved character stores in appearance.look.
const LOOK_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}\/[a-z0-9][a-z0-9_-]{0,79}$/;
const MODEL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.glb$/;
const THUMB_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpg|jpeg|webp)$/i;
const NAME_RE = /^[^\u0000-\u001f<>"'`\\]{1,64}$/;
const RACE_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
// Roles the client understands (charmesh.js CHARACTER_ROLES).
const CLIP_ROLES = new Set(['idle', 'walk', 'attack', 'cast', 'hit', 'death', 'talk', 'heavy', 'carry_idle', 'carry_walk']);
const BODY_TYPES = new Set(['male', 'female']);
const DEFAULT_HEIGHT = 1.15;

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanName = value => (typeof value === 'string' && NAME_RE.test(value.trim()) ? value.trim() : null);

function sanitizeLook(packId, packDir, id, raw) {
  if (!isRecord(raw)) return { error: 'entry is not an object' };
  if (typeof raw.file !== 'string' || !MODEL_FILE_RE.test(raw.file)) return { error: 'missing or invalid "file" (a .glb name inside the pack folder)' };
  if (!fs.existsSync(path.join(packDir, raw.file))) return { error: `file not found: ${raw.file}` };
  let height = DEFAULT_HEIGHT;
  if (raw.height !== undefined) {
    height = Number(raw.height);
    if (!Number.isFinite(height) || height < 0.2 || height > 4) return { error: '"height" must be 0.2–4 world units' };
  }
  const look = {
    id: `${packId}/${id}`,
    name: cleanName(raw.name) || id,
    pack: packId,
    url: `/packs/${packId}/${raw.file}`,
    height
  };
  if (Array.isArray(raw.races)) {
    const races = raw.races.slice(0, 16)
      .map(race => String(race).toLowerCase()).filter(race => RACE_RE.test(race));
    if (races.length) look.races = [...new Set(races)];
  }
  if (BODY_TYPES.has(raw.body)) look.body = raw.body;
  if (typeof raw.animations === 'string' && MODEL_FILE_RE.test(raw.animations)) {
    if (!fs.existsSync(path.join(packDir, raw.animations))) return { error: `file not found: ${raw.animations}` };
    look.animUrl = `/packs/${packId}/${raw.animations}`;
  }
  if (isRecord(raw.clips)) {
    const clips = {};
    for (const [role, name] of Object.entries(raw.clips).slice(0, 32)) {
      const clip = cleanName(name);
      if (CLIP_ROLES.has(role) && clip) clips[role] = clip;
    }
    if (Object.keys(clips).length) look.clips = clips;
  }
  if (typeof raw.thumb === 'string' && THUMB_FILE_RE.test(raw.thumb) && fs.existsSync(path.join(packDir, raw.thumb))) {
    look.thumb = `/packs/${packId}/${raw.thumb}`;
  }
  if (raw.toon === true) {
    look.toon = true;
    const outline = Number(raw.outline);
    if (raw.outline !== undefined && Number.isFinite(outline)) look.outline = Math.max(0, Math.min(3, outline));
  }
  return { look };
}

function sanitizeProp(packId, packDir, id, raw) {
  if (!isRecord(raw)) return { error: 'entry is not an object' };
  if (typeof raw.file !== 'string' || !MODEL_FILE_RE.test(raw.file)) return { error: 'missing or invalid "file" (a .glb name inside the pack folder)' };
  if (!fs.existsSync(path.join(packDir, raw.file))) return { error: `file not found: ${raw.file}` };
  const items = Array.isArray(raw.items)
    ? [...new Set(raw.items.slice(0, 32).map(item => String(item).toLowerCase()).filter(item => RACE_RE.test(item)))] : [];
  if (!items.length) return { error: '"items" must list at least one item index' };
  let length = 0.6;
  if (raw.length !== undefined) {
    length = Number(raw.length);
    if (!Number.isFinite(length) || length < 0.05 || length > 4) return { error: '"length" must be 0.05–4 world units' };
  }
  const prop = { id: `${packId}/${id}`, name: cleanName(raw.name) || id, pack: packId, url: `/packs/${packId}/${raw.file}`, length, items };
  if (raw.attack === 'heavy') prop.attack = 'heavy';
  return { prop };
}

// Read every pack under `dir`. Returns
// { looks: { "<pack>/<id>" -> look }, props: { "<pack>/<id>" -> prop }, packs: [{ id, name, count }], warnings: [] }.
function loadCharacterPacks(dir) {
  const result = { looks: Object.create(null), props: Object.create(null), packs: [], warnings: [] };
  let folders;
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return result; // no packs folder: the normal case
  }
  for (const folder of folders.filter(item => item.isDirectory()).map(item => item.name).sort()) {
    const packDir = path.join(dir, folder);
    const jsonPath = path.join(packDir, 'pack.json');
    if (!fs.existsSync(jsonPath) || !PACK_ID_RE.test(folder)) continue; // monster-packs reports bad folders
    let json;
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));   // Windows editors add a BOM
    } catch (_) {
      continue; // reported by monster-packs
    }
    if (!isRecord(json) || (json.characters === undefined && json.props === undefined)) continue;
    if (json.props !== undefined && !isRecord(json.props)) result.warnings.push(`${folder}: "props" must be an object`);
    for (const [rawId, rawEntry] of Object.entries(isRecord(json.props) ? json.props : {}).slice(0, 200)) {
      const id = String(rawId).toLowerCase();
      const { prop, error } = LOOK_ID_RE.test(id) ? sanitizeProp(folder, packDir, id, rawEntry) : { error: 'invalid prop id' };
      if (error) result.warnings.push(`${folder}/${rawId}: ${error}`);
      else result.props[prop.id] = prop;
    }
    if (json.characters === undefined) continue;
    if (!isRecord(json.characters)) {
      result.warnings.push(`${folder}: "characters" must be an object`);
      continue;
    }
    let count = 0;
    for (const [rawId, rawEntry] of Object.entries(json.characters).slice(0, 500)) {
      const id = String(rawId).toLowerCase();
      if (!LOOK_ID_RE.test(id)) {
        result.warnings.push(`${folder}: invalid character id "${rawId}"`);
        continue;
      }
      const { look, error } = sanitizeLook(folder, packDir, id, rawEntry);
      if (error) {
        result.warnings.push(`${folder}/${id}: ${error}`);
        continue;
      }
      result.looks[look.id] = look;
      count += 1;
    }
    result.packs.push({ id: folder, name: typeof json.name === 'string' ? json.name.slice(0, 80) : folder, count });
  }
  return result;
}

// The character kit as this server can serve it. kit.json lists the owner's
// private parts (license "private": the race body-form sculpts with their
// morphs, and the plate/mail/leather armour sets), whose files are kept out of
// the repo, so a clone has the entries but not the files. Those entries are
// dropped here, together with the sliders that drive their morphs; charmesh.js
// then dresses a dragonborn or tabaxi on the plain kit body, and equipped
// armour leaves the wardrobe on. Returns { kit, dropped: [ids] }.
function loadCharacterKit(kitDir) {
  const kit = JSON.parse(fs.readFileSync(path.join(kitDir, 'kit.json'), 'utf8'));
  const dropped = [], morphs = new Set();
  for (const [id, asset] of Object.entries(kit.assets || {})) {
    if (asset.license !== 'private' || fs.existsSync(path.join(kitDir, 'assets', id, 'mesh.bin'))) continue;
    if (asset.target) morphs.add(asset.target);
    delete kit.assets[id];
    dropped.push(id);
  }
  // A dropped form's morph goes too when its file is missing (a gap in the CC0 set stays visible).
  for (const target of morphs) {
    if (fs.existsSync(path.join(kitDir, 'targets', `${target}.bin`))) continue;
    delete kit.targets[target];
    for (const [id, slider] of Object.entries(kit.sliders || {})) {
      if ([...slider.neg, ...slider.pos].includes(target)) delete kit.sliders[id];
    }
  }
  return { kit, dropped };
}

module.exports = { loadCharacterPacks, loadCharacterKit, LOOK_KEY_RE, CLIP_ROLES };
