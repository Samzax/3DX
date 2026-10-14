// homebrew.cjs — canonical schemas for shared homebrew rules content: races,
// subraces, classes, subclasses, backgrounds, feats, spells and items.
// (Monsters keep their own sanitizer in server.js.)
//
// Homebrew is user-authored content that every client merges into its SRD
// tables, so each record is rebuilt field by field here — nothing is cloned
// from the wire. The shapes deliberately mirror the vendored SRD JSON (so
// srd.js treats both alike) plus one shared "feature" block that carries the
// optional mechanics: passive grants, a combat action, a damage rider, a
// resource pool, a pick-N choice and prerequisites. public/js/shared/rules.js
// is the client that interprets those blocks.

'use strict';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const REFERENCE_RE = /^[A-Za-z0-9_-]+$/;
const DICE_RE = /^\s*(?:\d{1,2}\s*d\s*\d{1,3}|\d{1,3})?(?:\s*[+\-*/]?\s*(?:\d{1,3}|[A-Za-z]{2,10}|[()]))*\s*$/;
const FORMULA_RE = /^[0-9A-Za-z+\-*/() ]{1,40}$/;
// The only names a dice or count expression may reference (rules.js evalFormula).
const FORMULA_NAMES = new Set(['level', 'classLevel', 'prof', ...ABILITIES]);
const knownNames = (expr) => (expr.replace(/\d+\s*d\s*\d+/gi, '').match(/[A-Za-z]+/g) || [])
  .every(name => FORMULA_NAMES.has(name));

const HOMEBREW_COLLECTIONS = {
  race: 'races', subrace: 'subraces', class: 'classes', subclass: 'subclasses',
  background: 'backgrounds', feat: 'feats', spell: 'spells', item: 'items',
  monster: 'monsters'
};
const MAX_RULES_BYTES = 160 * 1024;

const ACTION_TYPES = new Set(['attack', 'save', 'heal', 'utility']);
const ACTION_COSTS = new Set(['action', 'bonus', 'free', 'attack']);
const ACTION_AREAS = new Set(['single', 'cone', 'line', 'sphere', 'cube', 'self']);
const ACTION_GRANTS = new Set(['dash', 'dodge', 'disengage', 'attacks', 'action']);
const RECHARGES = new Set(['short', 'long', 'combat', 'turn']);
const RIDER_APPLIES = new Set(['any', 'melee', 'ranged', 'finesse-or-ranged', 'unarmed']);
// Mirrors server.js CONDITION_LABELS (the server re-checks every key it uses).
const EFFECT_KEYS = new Set([
  'dodging', 'disengaged', 'dashed', 'prone', 'poisoned', 'restrained', 'stunned',
  'blinded', 'frightened', 'grappled', 'invisible', 'raging', 'hidden', 'blessed',
  'paralyzed'
]);
const CASTER_TYPES = new Set(['none', 'full', 'half', 'third', 'pact']);
const SPELL_LISTS = new Set([
  'bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'
]);
const SIZES = ['Tiny', 'Small', 'Medium', 'Large'];
const WEAPON_PROPERTIES = new Set([
  'ammunition', 'finesse', 'heavy', 'light', 'loading', 'reach', 'thrown',
  'two-handed', 'versatile', 'monk', 'special'
]);
const ITEM_KINDS = new Set(['weapon', 'armor', 'gear']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

// Single-line text: names and labels never carry line breaks.
function line(value, maxLength) {
  return text(value, maxLength).replace(/\s+/g, ' ');
}

function integer(value, min, max, fallback = null) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function reference(value, maxLength = 96) {
  const candidate = line(value, maxLength);
  return candidate && REFERENCE_RE.test(candidate) ? candidate : null;
}

function slug(value) {
  return line(value, 96).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function referenceRecord(raw, allowed = null) {
  if (!isRecord(raw)) return null;
  const index = reference(raw.index);
  if (!index || (allowed && !allowed.has(index))) return null;
  const record = { index };
  const name = line(raw.name, 120);
  if (name) record.name = name;
  return record;
}

function referenceList(raw, maxItems = 64, allowed = null) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw.slice(0, maxItems)) {
    const record = referenceRecord(entry, allowed);
    if (!record || seen.has(record.index)) continue;
    seen.add(record.index);
    out.push(record);
  }
  return out;
}

function referenceStrings(raw, maxItems = 32, allowed = null) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, maxItems)) {
    const value = reference(entry, 60);
    if (!value || out.includes(value) || (allowed && !allowed.has(value))) continue;
    out.push(value);
  }
  return out;
}

function textList(raw, maxItems = 32, maxLength = 60) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, maxItems)) {
    const value = line(entry, maxLength);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// "2d6", "1d8+dex", "classLevel" — resolved to concrete dice by the client.
function dice(value) {
  const candidate = line(value, 24);
  return candidate && DICE_RE.test(candidate) && knownNames(candidate) ? candidate.replace(/\s+/g, '') : '';
}

// A count such as 3, "prof", "classLevel" or "1+cha".
function formula(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.max(0, Math.min(999, Math.floor(value))));
  const candidate = line(value, 40);
  return candidate && FORMULA_RE.test(candidate) && knownNames(candidate) ? candidate.replace(/\s+/g, '') : '';
}

function scalingList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, 12)) {
    if (!isRecord(entry)) continue;
    const level = integer(entry.level, 1, 20, null);
    const damage = dice(entry.damage);
    if (level != null && damage) out.push({ level, damage });
  }
  return out.sort((a, b) => a.level - b.level);
}

function effectKey(value) {
  const key = line(value, 24);
  return EFFECT_KEYS.has(key) ? key : '';
}

function sanitizeGrants(raw) {
  if (!isRecord(raw)) return null;
  const grants = {};
  if (isRecord(raw.abilities)) {
    const abilities = {};
    for (const ability of ABILITIES) {
      const bonus = integer(raw.abilities[ability], -5, 10, 0);
      if (bonus) abilities[ability] = bonus;
    }
    if (Object.keys(abilities).length) grants.abilities = abilities;
  }
  const lists = {
    skills: referenceStrings(raw.skills, 18),
    expertise: referenceStrings(raw.expertise, 18),
    saves: referenceStrings(raw.saves, 6, new Set(ABILITIES)),
    // Rolls: advantage on these saves (Danger Sense), and ability checks that
    // never total less than the score itself (Indomitable Might).
    saveAdvantage: referenceStrings(raw.saveAdvantage, 6, new Set(ABILITIES)),
    checkFloor: referenceStrings(raw.checkFloor, 6, new Set(ABILITIES)),
    proficiencies: textList(raw.proficiencies, 32, 60),
    languages: textList(raw.languages, 16, 40),
    resistances: textList(raw.resistances, 13, 24),
    immunities: textList(raw.immunities, 13, 24)
  };
  for (const [key, value] of Object.entries(lists)) if (value.length) grants[key] = value;
  if (isRecord(raw.skillChoice)) {
    const from = referenceStrings(raw.skillChoice.from, 18);
    const choose = integer(raw.skillChoice.choose, 0, 18, 0);
    if (choose > 0) grants.skillChoice = { choose, from };
  }
  const numbers = {
    expertiseChoice: [0, 6], languageChoice: [0, 6], speed: [-30, 120], ac: [-5, 10],
    hpPerLevel: [0, 5], initiative: [-10, 20], darkvision: [0, 300],
    blindsight: [0, 300], truesight: [0, 300], tremorsense: [0, 300], devilsSight: [0, 300],
    attacksPerAction: [1, 4], critRange: [18, 20]
  };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const value = integer(raw[key], min, max, 0);
    if (value) grants[key] = value;
  }
  if (isRecord(raw.speeds)) {
    const speeds = {};
    for (const mode of ['climb', 'fly', 'swim', 'burrow']) {
      const value = integer(raw.speeds[mode], 0, 240, 0);
      if (value) speeds[mode] = value;
    }
    if (Object.keys(speeds).length) grants.speeds = speeds;
  }
  if (isRecord(raw.acFormula)) {
    grants.acFormula = {
      base: integer(raw.acFormula.base, 8, 20, 10),
      abilities: referenceStrings(raw.acFormula.abilities, 2, new Set(ABILITIES)),
      shield: raw.acFormula.shield !== false
    };
  }
  const unarmed = dice(raw.unarmedDamage);
  if (unarmed) grants.unarmedDamage = unarmed;
  if (raw.unarmedFinesse === true) grants.unarmedFinesse = true;
  if (raw.monkWeapons === true) grants.monkWeapons = true;
  if (raw.initiativeProf === true) grants.initiativeProf = true;
  if (raw.blind === true) grants.blind = true;   // no ordinary sight: only the special senses see
  const saveBonus = formula(raw.saveBonus);      // added to every save (Aura of Protection: "cha")
  if (saveBonus && saveBonus !== '0') grants.saveBonus = saveBonus;
  if (raw.evasion === true) grants.evasion = true;
  if (raw.concentrationAdvantage === true) grants.concentrationAdvantage = true;
  const checkMinDie = integer(raw.checkMinDie, 0, 20, 0);   // Reliable Talent: a proficient check's d20 reads at least this
  if (checkMinDie > 1) grants.checkMinDie = checkMinDie;
  return Object.keys(grants).length ? grants : null;
}

function sanitizeAction(raw) {
  if (!isRecord(raw) || !ACTION_TYPES.has(raw.type)) return null;
  const action = { type: raw.type };
  const label = line(raw.name, 40);   // button label when it differs from the feature
  if (label) action.name = label;
  action.cost = ACTION_COSTS.has(raw.cost) ? raw.cost : 'action';
  if (action.cost === 'attack' && action.type !== 'attack') action.cost = 'action';
  const damage = dice(raw.damage);
  if (damage) action.damage = damage;
  const damageType = line(raw.damageType, 20).toLowerCase();
  if (damageType) action.damageType = damageType;
  const scaling = scalingList(raw.scaling);
  if (scaling.length) action.scaling = scaling;
  if (action.type === 'attack') {
    action.ability = raw.ability === 'best' || ABILITIES.includes(raw.ability) ? raw.ability : 'str';
    action.proficient = raw.proficient !== false;
    if (raw.ranged === true) action.ranged = true;
  }
  if (action.type === 'save') {
    action.saveAbility = ABILITIES.includes(raw.saveAbility) ? raw.saveAbility : 'dex';
    action.saveSuccess = raw.saveSuccess === 'none' ? 'none' : 'half';
  }
  if (action.type === 'save' || raw.dc != null || raw.dcAbility) {
    const fixed = integer(raw.dc, 1, 40, null);
    if (fixed != null) action.dc = fixed;
    else action.dcAbility = ABILITIES.includes(raw.dcAbility) ? raw.dcAbility : 'con';
  }
  action.rangeFt = integer(raw.rangeFt, 0, 600, 5);
  action.area = ACTION_AREAS.has(raw.area) ? raw.area : 'single';
  if (action.area !== 'single' && action.area !== 'self') {
    action.areaFt = integer(raw.areaFt, 5, 300, 15);
  }
  action.maxTargets = integer(raw.maxTargets, 1, 12, action.area === 'single' ? 1 : 6);
  if (action.area === 'self') action.maxTargets = 0;
  const uses = formula(raw.uses);
  if (uses) {
    action.uses = uses;
    action.recharge = RECHARGES.has(raw.recharge) ? raw.recharge : 'short';
  }
  const resource = reference(raw.resource, 24);
  if (resource) {
    action.resource = resource;
    action.resourceCost = integer(raw.resourceCost, 1, 20, 1);
  }
  const effect = effectKey(raw.effect);
  if (effect) action.effect = effect;
  const selfEffect = effectKey(raw.selfEffect);
  if (selfEffect) action.selfEffect = selfEffect;
  if (ACTION_GRANTS.has(raw.grant)) {
    action.grant = raw.grant;
    if (raw.grant === 'attacks') {
      action.grantCount = integer(raw.grantCount, 1, 4, 1);
      const only = line(raw.grantAttack, 30);
      if (only) action.grantAttack = only;
    }
  }
  return action;
}

function sanitizeRider(raw) {
  if (!isRecord(raw)) return null;
  const damage = dice(raw.damage);
  if (!damage) return null;
  const rider = {
    damage,
    applies: RIDER_APPLIES.has(raw.applies) ? raw.applies : 'any',
    oncePerTurn: raw.oncePerTurn !== false
  };
  const damageType = line(raw.damageType, 20).toLowerCase();
  if (damageType) rider.damageType = damageType;
  const scaling = scalingList(raw.scaling);
  if (scaling.length) rider.scaling = scaling;
  const requiresEffect = effectKey(raw.requiresEffect);
  if (requiresEffect) rider.requiresEffect = requiresEffect;
  if (raw.auto === true) rider.auto = true;
  return rider;
}

function sanitizeResource(raw) {
  if (!isRecord(raw)) return null;
  const key = reference(raw.key, 24);
  const max = formula(raw.max);
  if (!key || !max) return null;
  return {
    key,
    name: line(raw.name, 40) || key,
    max,
    recharge: RECHARGES.has(raw.recharge) ? raw.recharge : 'short'
  };
}

function sanitizePrereq(raw) {
  if (!isRecord(raw)) return null;
  const prereq = {};
  const level = integer(raw.level, 1, 20, null);
  if (level != null && level > 1) prereq.level = level;
  if (isRecord(raw.abilities)) {
    const abilities = {};
    for (const ability of ABILITIES) {
      const minimum = integer(raw.abilities[ability], 1, 30, null);
      if (minimum != null && minimum > 1) abilities[ability] = minimum;
    }
    if (Object.keys(abilities).length) prereq.abilities = abilities;
  }
  const note = line(raw.text, 200);
  if (note) prereq.text = note;
  return Object.keys(prereq).length ? prereq : null;
}

// The shared feature block. withLevel keeps the class/subclass level gate;
// choice options are features too, but only one level deep.
function sanitizeFeature(raw, { withLevel = false, depth = 0 } = {}) {
  if (!isRecord(raw)) return null;
  const name = line(raw.name, 120);
  if (!name) return null;
  const feature = { name };
  if (withLevel) feature.level = integer(raw.level, 1, 20, 1);
  const desc = Array.isArray(raw.desc) ? raw.desc.map(part => text(part, 4000)).filter(Boolean).join('\n\n') : raw.desc;
  feature.desc = text(desc, 4000);
  const grants = sanitizeGrants(raw.grants);
  if (grants) feature.grants = grants;
  const action = sanitizeAction(raw.action);
  if (action) feature.action = action;
  const rider = sanitizeRider(raw.rider);
  if (rider) feature.rider = rider;
  const resource = sanitizeResource(raw.resource);
  if (resource) feature.resource = resource;
  const prereq = sanitizePrereq(raw.prereq);
  if (prereq) feature.prereq = prereq;
  if (depth === 0 && isRecord(raw.choice) && Array.isArray(raw.choice.options)) {
    const options = [];
    for (const option of raw.choice.options.slice(0, 40)) {
      const sanitized = sanitizeFeature(option, { depth: 1 });
      if (sanitized && !options.some(existing => existing.name === sanitized.name)) options.push(sanitized);
    }
    const choose = integer(raw.choice.choose, 1, 6, 1);
    if (options.length) feature.choice = { choose: Math.min(choose, options.length), options };
  }
  return feature;
}

function featureList(raw, options = {}, maxItems = 64) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, maxItems).map(entry => sanitizeFeature(entry, options)).filter(Boolean);
}

function abilityBonuses(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw.slice(0, ABILITIES.length)) {
    if (!isRecord(entry)) continue;
    const ability = referenceRecord(entry.ability_score, new Set(ABILITIES));
    const bonus = integer(entry.bonus, -5, 10, null);
    if (!ability || bonus == null || out.some(existing => existing.ability_score.index === ability.index)) continue;
    out.push({ ability_score: { index: ability.index, name: ability.index.toUpperCase() }, bonus });
  }
  return out;
}

function abilityBonusOptions(raw) {
  if (!isRecord(raw) || !isRecord(raw.from) || !Array.isArray(raw.from.options)) return null;
  const options = [];
  for (const option of raw.from.options.slice(0, ABILITIES.length)) {
    const ability = referenceRecord(option && option.ability_score, new Set(ABILITIES));
    if (ability && !options.some(existing => existing.ability_score.index === ability.index)) {
      options.push({ ability_score: { index: ability.index, name: ability.index.toUpperCase() }, bonus: 1 });
    }
  }
  const choose = integer(raw.choose, 0, options.length, 0);
  return choose > 0 && options.length ? { choose, from: { options } } : null;
}

// Alternative spreads for a race whose ability increase is a choice between
// spreads (Monsters of the Multiverse: "+2 and +1, or +1 to three different
// scores"). A spread is an ordered list of bonuses; the player picks one
// spread and fills its slots with different abilities.
function abilitySpreads(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, 3)) {
    if (!isRecord(entry) || !Array.isArray(entry.bonuses)) continue;
    const bonuses = [];
    for (const value of entry.bonuses.slice(0, 3)) {
      const bonus = integer(value, 1, 3, null);
      if (bonus != null) bonuses.push(bonus);
    }
    if (!bonuses.length || out.some(existing => existing.bonuses.join() === bonuses.join())) continue;
    out.push({ bonuses });
  }
  return out.length ? out : null;
}

function languageList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, 16)) {
    const name = line(isRecord(entry) ? (entry.name || entry.index) : entry, 40);
    const index = slug(name);
    if (name && index && !out.some(existing => existing.index === index)) out.push({ index, name });
  }
  return out;
}

function skillProficiencies(raw) {
  return referenceList(raw, 32);
}

function sanitizeRace(raw, data) {
  const size = line(raw.size, 20);
  data.size = SIZES.includes(size) ? size : 'Medium';
  data.speed = integer(raw.speed, 0, 120, 30);
  data.desc = text(raw.desc, 4000);
  data.ability_bonuses = abilityBonuses(raw.ability_bonuses);
  const options = abilityBonusOptions(raw.ability_bonus_options);
  if (options) data.ability_bonus_options = options;
  const spreads = abilitySpreads(raw.ability_spreads);
  if (spreads) data.ability_spreads = spreads;
  data.starting_proficiencies = skillProficiencies(raw.starting_proficiencies);
  data.languages = languageList(raw.languages);
  data.traits = featureList(raw.traits);
  // Subraces are their own homebrew records (type "subrace"); the field stays
  // in the race shape because SRD races carry it.
  data.subraces = [];
  return data;
}

function sanitizeSubrace(raw, data) {
  const race = referenceRecord(raw.race);
  if (!race) return null;
  data.race = race;
  data.desc = text(raw.desc, 4000);
  data.ability_bonuses = abilityBonuses(raw.ability_bonuses);
  data.starting_proficiencies = skillProficiencies(raw.starting_proficiencies);
  data.languages = languageList(raw.languages);
  data.traits = featureList(raw.traits);
  return data;
}

function sanitizeClass(raw, data) {
  data.desc = text(raw.desc, 4000);
  data.hit_die = integer(raw.hit_die, 4, 20, 8);
  data.saving_throws = referenceList(raw.saving_throws, 6, new Set(ABILITIES))
    .map(entry => ({ index: entry.index, name: entry.index.toUpperCase() }));
  data.proficiencies = referenceList(raw.proficiencies, 64);
  data.proficiency_choices = [];
  if (Array.isArray(raw.proficiency_choices)) {
    for (const group of raw.proficiency_choices.slice(0, 8)) {
      if (!isRecord(group) || !isRecord(group.from) || !Array.isArray(group.from.options)) continue;
      const options = group.from.options.slice(0, 64).map((option) => {
        const item = referenceRecord(isRecord(option) ? option.item : null);
        return item ? { option_type: 'reference', item } : null;
      }).filter(Boolean);
      const choose = integer(group.choose, 0, options.length, 0);
      if (choose > 0 && options.length) {
        data.proficiency_choices.push({
          choose, type: 'proficiencies', from: { option_set_type: 'options_array', options }
        });
      }
    }
  }
  data.subclasses = [];
  data.subclassLevel = integer(raw.subclassLevel, 1, 20, 3);
  const caster = line(raw.caster, 12);
  data.caster = CASTER_TYPES.has(caster) ? caster : 'none';
  const spellAbility = isRecord(raw.spellcasting)
    ? referenceRecord(raw.spellcasting.spellcasting_ability, new Set(ABILITIES)) : null;
  data.spellcasting = data.caster !== 'none' && spellAbility
    ? { spellcasting_ability: { index: spellAbility.index, name: spellAbility.index.toUpperCase() } }
    : null;
  if (!data.spellcasting) data.caster = 'none';
  // spellList borrows an SRD class's list; null means "only spells that name
  // this class" (homebrew spells can list any class index).
  const spellList = reference(raw.spellList, 32);
  data.spellList = data.caster !== 'none' && SPELL_LISTS.has(spellList) ? spellList : null;
  data.customFeatures = featureList(raw.customFeatures, { withLevel: true }, 120);
  return data;
}

function sanitizeSubclass(raw, data) {
  const parent = referenceRecord(raw.class);
  if (!parent) return null;
  data.class = parent;
  data.desc = text(raw.desc, 4000);
  data.subclass_flavor = line(raw.subclass_flavor, 60);
  data.features = featureList(raw.features, { withLevel: true }, 80);
  return data;
}

// Suggested characteristics (personality traits, ideals, bonds, flaws), kept in
// the SRD's own shape so the creator reads SRD and homebrew backgrounds alike.
function suggestionTable(raw) {
  const source = isRecord(raw) && isRecord(raw.from) ? raw.from.options : raw;
  if (!Array.isArray(source)) return null;
  const options = [];
  for (const entry of source.slice(0, 24)) {
    const value = line(isRecord(entry) ? (entry.string || entry.desc) : entry, 400);
    if (value && !options.some(option => option.string === value)) options.push({ option_type: 'string', string: value });
  }
  if (!options.length) return null;
  return {
    choose: integer(isRecord(raw) ? raw.choose : null, 1, 4, 1),
    from: { option_set_type: 'options_array', options }
  };
}

// Any other roll-or-choose table a background brings ("Scam", "Origin").
function flavorTables(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, 6)) {
    if (!isRecord(entry)) continue;
    const name = line(entry.name, 60);
    const options = textList(entry.options, 24, 400);
    if (name && options.length) out.push({ name, options });
  }
  return out;
}

function startingEquipment(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, 24)) {
    const equipment = referenceRecord(isRecord(entry) ? entry.equipment : null);
    if (equipment) out.push({ equipment, quantity: integer(entry.quantity, 1, 99, 1) });
  }
  return out;
}

function sanitizeBackground(raw, data) {
  data.desc = text(raw.desc, 4000);
  data.starting_proficiencies = skillProficiencies(raw.starting_proficiencies);
  data.tools = textList(raw.tools, 12, 60);
  data.languages = languageList(raw.languages);
  data.languageChoice = integer(raw.languageChoice, 0, 6, 0);
  data.equipment = text(raw.equipment, 1000);
  data.features = featureList(raw.features, {}, 8);
  // Everything below is optional: a background without it keeps its old shape.
  const source = line(raw.source, 80);          // the book it comes from (imports)
  if (source) data.source = source;
  for (const key of ['personality_traits', 'ideals', 'bonds', 'flaws']) {
    const table = suggestionTable(raw[key]);
    if (table) data[key] = table;
  }
  const tables = flavorTables(raw.tables);
  if (tables.length) data.tables = tables;
  const kit = startingEquipment(raw.starting_equipment);
  if (kit.length) data.starting_equipment = kit;
  const gold = isRecord(raw.starting_gold) ? integer(raw.starting_gold.quantity, 0, 9999, 0) : 0;
  if (gold) data.starting_gold = { quantity: gold, unit: 'gp' };
  return data;
}

function sanitizeFeat(raw, data) {
  const feature = sanitizeFeature({ ...raw, name: data.name });
  if (!feature) return null;
  Object.assign(data, feature);
  return data;
}

function slotDamage(raw) {
  if (!isRecord(raw)) return null;
  const out = {};
  for (const [level, value] of Object.entries(raw).slice(0, 24)) {
    const key = integer(level, 0, 20, null);
    const damage = dice(value);
    if (key != null && damage) out[String(key)] = damage;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeSpell(raw, data) {
  data.level = integer(raw.level, 0, 9, 0);
  const school = line(isRecord(raw.school) ? (raw.school.name || raw.school.index) : raw.school, 30);
  data.school = { index: slug(school) || 'evocation', name: school || 'Evocation' };
  data.classes = referenceList(raw.classes, 24);
  data.casting_time = line(raw.casting_time, 60) || '1 action';
  data.range = line(raw.range, 60) || 'Self';
  data.components = textList(raw.components, 3, 1).filter(part => ['V', 'S', 'M'].includes(part));
  data.material = line(raw.material, 200);
  data.duration = line(raw.duration, 60) || 'Instantaneous';
  data.concentration = raw.concentration === true;
  data.ritual = raw.ritual === true;
  const desc = Array.isArray(raw.desc) ? raw.desc : [raw.desc];
  data.desc = desc.slice(0, 12).map(part => text(part, 4000)).filter(Boolean);
  data.higher_level = (Array.isArray(raw.higher_level) ? raw.higher_level : [raw.higher_level])
    .slice(0, 4).map(part => text(part, 2000)).filter(Boolean);
  if (raw.attack_type === 'melee' || raw.attack_type === 'ranged') data.attack_type = raw.attack_type;
  if (isRecord(raw.dc)) {
    const type = referenceRecord(raw.dc.dc_type, new Set(ABILITIES));
    if (type) {
      data.dc = {
        dc_type: { index: type.index, name: type.index.toUpperCase() },
        dc_success: raw.dc.dc_success === 'half' ? 'half' : 'none'
      };
    }
  }
  if (isRecord(raw.damage)) {
    const damage = {};
    const typeName = line(isRecord(raw.damage.damage_type)
      ? (raw.damage.damage_type.name || raw.damage.damage_type.index) : raw.damage.damage_type, 20);
    if (typeName) damage.damage_type = { index: slug(typeName), name: typeName };
    const bySlot = slotDamage(raw.damage.damage_at_slot_level);
    const byLevel = slotDamage(raw.damage.damage_at_character_level);
    if (bySlot && data.level > 0) damage.damage_at_slot_level = bySlot;
    if (byLevel && data.level === 0) damage.damage_at_character_level = byLevel;
    if (damage.damage_at_slot_level || damage.damage_at_character_level) data.damage = damage;
  }
  return data;
}

function sanitizeItem(raw, data) {
  const kind = ITEM_KINDS.has(raw.kind) ? raw.kind : 'gear';
  data.kind = kind;
  data.desc = text(Array.isArray(raw.desc) ? raw.desc.join('\n\n') : raw.desc, 4000);
  data.cost = line(typeof raw.cost === 'string' ? raw.cost : '', 40);
  data.weight = integer(raw.weight, 0, 9999, 0);
  const bonus = integer(raw.bonus, -3, 5, 0);
  if (bonus) data.bonus = bonus;
  const grants = sanitizeGrants(raw.grants);
  if (grants) data.grants = grants;
  if (kind === 'weapon') {
    data.equipment_category = { index: 'weapon', name: 'Weapon' };
    data.weapon_category = raw.weapon_category === 'Martial' ? 'Martial' : 'Simple';
    data.weapon_range = raw.weapon_range === 'Ranged' ? 'Ranged' : 'Melee';
    const rawDamage = isRecord(raw.damage) ? raw.damage : {};
    const typeName = line(isRecord(rawDamage.damage_type)
      ? (rawDamage.damage_type.name || rawDamage.damage_type.index) : rawDamage.damage_type, 20) || 'Bludgeoning';
    data.damage = {
      damage_dice: dice(rawDamage.damage_dice) || '1d4',
      damage_type: { index: slug(typeName), name: typeName }
    };
    const twoHanded = isRecord(raw.two_handed_damage) ? dice(raw.two_handed_damage.damage_dice) : '';
    if (twoHanded) {
      data.two_handed_damage = { damage_dice: twoHanded, damage_type: data.damage.damage_type };
    }
    const rawRange = isRecord(raw.range) ? raw.range : {};
    data.range = { normal: integer(rawRange.normal, 5, 600, 5) };
    const long = integer(rawRange.long, 5, 2400, null);
    if (long != null && long > data.range.normal) data.range.long = long;
    data.properties = referenceList(raw.properties, 12, WEAPON_PROPERTIES);
  } else if (kind === 'armor') {
    data.equipment_category = { index: 'armor', name: 'Armor' };
    const category = line(raw.armor_category, 12);
    data.armor_category = ['Light', 'Medium', 'Heavy', 'Shield'].includes(category) ? category : 'Light';
    const rawAC = isRecord(raw.armor_class) ? raw.armor_class : {};
    data.armor_class = {
      base: integer(rawAC.base, 0, 30, 11),
      dex_bonus: rawAC.dex_bonus !== false
    };
    const maxBonus = integer(rawAC.max_bonus, 0, 10, null);
    if (maxBonus != null) data.armor_class.max_bonus = maxBonus;
    data.str_minimum = integer(raw.str_minimum, 0, 30, 0);
    data.stealth_disadvantage = raw.stealth_disadvantage === true;
  } else {
    data.equipment_category = { index: 'adventuring-gear', name: 'Adventuring Gear' };
  }
  return data;
}

const SANITIZERS = {
  race: sanitizeRace, subrace: sanitizeSubrace, class: sanitizeClass, subclass: sanitizeSubclass,
  background: sanitizeBackground, feat: sanitizeFeat, spell: sanitizeSpell, item: sanitizeItem
};

// Rules homebrew (everything except monsters). Returns the canonical record
// without index/owner bookkeeping beyond a validated requested index, or null.
function sanitizeRulesHomebrew(type, raw) {
  const sanitize = SANITIZERS[type];
  if (!sanitize || !isRecord(raw)) return null;
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8'); } catch (_) { /* cyclic */ }
  if (bytes > MAX_RULES_BYTES) return null;
  const name = line(raw.name, 60);
  if (!name) return null;
  const data = { name };
  const requestedIndex = reference(raw.index);
  if (requestedIndex) data.index = requestedIndex;
  return sanitize(raw, data);
}

module.exports = {
  HOMEBREW_COLLECTIONS, EFFECT_KEYS, sanitizeRulesHomebrew, sanitizeFeature
};
