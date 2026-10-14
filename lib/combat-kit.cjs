// combat-kit.cjs — canonical shapes for what a combatant can DO: weapon
// attacks, feature abilities (breath weapons, ki moves, heals), damage riders
// (Sneak Attack) and resource pools. Clients derive these from the sheet
// (public/js/shared/rules.js) and submit them with combat-set-stats; the
// server rebuilds every field here before it trusts or persists one, and
// reuses the same builders when repairing persisted combat on load.

'use strict';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// Conditions a combatant can carry. auto:true effects (Dash/Dodge/Disengage)
// are stripped at the start of that combatant's next turn. Mirrored by EFFECTS
// in public/js/shared/combat.js.
const CONDITION_LABELS = {
  dodging: 'Dodge', disengaged: 'Disengage', dashed: 'Dash', down: 'Down',
  prone: 'Prone', poisoned: 'Poisoned', restrained: 'Restrained', stunned: 'Stunned',
  blinded: 'Blinded', frightened: 'Frightened', grappled: 'Grappled', invisible: 'Invisible',
  raging: 'Raging', hidden: 'Hidden', blessed: 'Blessed', flying: 'Flying',
  paralyzed: 'Paralyzed'
};

const ABILITY_TYPES = new Set(['attack', 'save', 'heal', 'utility']);
const ABILITY_COSTS = new Set(['action', 'bonus', 'free']);
const ABILITY_AREAS = new Set(['single', 'cone', 'line', 'sphere', 'cylinder', 'cube', 'self']);
// How a spell with no area looks on the map (shared/spellfx.js draws them).
const SPELL_FORMS = new Set(['bolt', 'ray', 'strike', 'touch', 'heal', 'aura']);
const ABILITY_GRANTS = new Set(['dash', 'dodge', 'disengage', 'attacks', 'action']);
const RIDER_APPLIES = new Set(['any', 'melee', 'ranged', 'finesse-or-ranged', 'unarmed']);
const ATTACK_TAGS = new Set(['melee', 'ranged', 'finesse', 'thrown', 'unarmed', 'natural']);
const RECHARGES = new Set(['short', 'long', 'combat', 'turn']);
const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,24}$/;
const DAMAGE_RE = /^\d{1,2}d\d{1,3}(?:[+-]\d{1,3})?$|^\d{1,3}$/;

const MAX_ATTACKS = 12;
const MAX_ABILITIES = 24;
const MAX_RIDERS = 8;
const MAX_RESOURCES = 12;
const MAX_SPELLS = 20;
const MAX_PENDING = 12;
const MAX_ZONES = 12;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function label(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

// "2d6+3" or a flat number; anything else is dropped so the dice roller only
// ever sees an expression it can parse.
function damageExpr(value, fallback = '') {
  const expr = label(String(value == null ? '' : value), 20).replace(/\s+/g, '');
  return DAMAGE_RE.test(expr) ? expr : fallback;
}

function normalizeAttack(raw) {
  const source = isRecord(raw) ? raw : {};
  const attack = {
    name: label(source.name, 30) || 'Attack',
    attack: clamp(source.attack, -10, 30, 0),
    damage: label(String(source.damage == null ? '' : source.damage), 20) || '1',
    damageType: label(source.damageType, 20),
    ranged: !!source.ranged,
    rangeFt: clamp(source.rangeFt, 5, 600, 5)
  };
  const parts = (Array.isArray(source.damageParts) ? source.damageParts : []).slice(0, 4).map(part => ({
    damage: label(String((part && part.damage) == null ? '' : part.damage), 20) || '1',
    damageType: label(part && part.damageType, 20)
  }));
  if (parts.length > 1) attack.damageParts = parts;
  const tags = (Array.isArray(source.tags) ? source.tags : []).filter(tag => ATTACK_TAGS.has(tag));
  if (tags.length) attack.tags = [...new Set(tags)];
  return attack;
}

function normalizeAttacks(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ATTACKS).map(normalizeAttack);
}

function normalizeAbility(raw) {
  if (!isRecord(raw) || !ABILITY_TYPES.has(raw.type)) return null;
  const ability = {
    name: label(raw.name, 40) || 'Ability',
    type: raw.type,
    cost: ABILITY_COSTS.has(raw.cost) ? raw.cost : 'action',
    damage: damageExpr(raw.damage),
    damageType: label(raw.damageType, 20),
    rangeFt: clamp(raw.rangeFt, 0, 600, 5),
    area: ABILITY_AREAS.has(raw.area) ? raw.area : 'single',
    areaFt: clamp(raw.areaFt, 0, 300, 0)
  };
  ability.maxTargets = ability.area === 'self' ? 0 : clamp(raw.maxTargets, 1, 12, 1);
  if (ability.type === 'attack') ability.attack = clamp(raw.attack, -10, 30, 0);
  if (ability.type === 'save') {
    ability.saveAbility = ABILITIES.includes(raw.saveAbility) ? raw.saveAbility : 'dex';
    ability.saveSuccess = raw.saveSuccess === 'none' ? 'none' : 'half';
    ability.dc = clamp(raw.dc, 1, 40, 10);
  }
  if (typeof raw.resource === 'string' && RESOURCE_KEY_RE.test(raw.resource)) {
    ability.resource = raw.resource;
    ability.resourceCost = clamp(raw.resourceCost, 1, 20, 1);
  }
  if (CONDITION_LABELS[raw.effect] && raw.effect !== 'down') ability.effect = raw.effect;
  if (CONDITION_LABELS[raw.selfEffect] && raw.selfEffect !== 'down') ability.selfEffect = raw.selfEffect;
  if (ABILITY_GRANTS.has(raw.grant)) {
    ability.grant = raw.grant;
    if (raw.grant === 'attacks') {
      ability.grantCount = clamp(raw.grantCount, 1, 4, 1);
      ability.grantAttack = label(raw.grantAttack, 30);
    }
  }
  // Recharge N (monster breath weapons): usable again once a d6 rolls >= N.
  const rechargeOn = clamp(raw.rechargeOn, 2, 6, null);
  if (rechargeOn != null) {
    ability.rechargeOn = rechargeOn;
    ability.spent = raw.spent === true;
  }
  return ability;
}

function normalizeAbilities(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ABILITIES).map(normalizeAbility).filter(Boolean);
}

function normalizeRider(raw) {
  if (!isRecord(raw)) return null;
  const damage = damageExpr(raw.damage);
  if (!damage) return null;
  const rider = {
    name: label(raw.name, 40) || 'Bonus damage',
    damage,
    damageType: label(raw.damageType, 20),
    applies: RIDER_APPLIES.has(raw.applies) ? raw.applies : 'any',
    oncePerTurn: raw.oncePerTurn !== false,
    auto: raw.auto === true
  };
  if (CONDITION_LABELS[raw.requiresEffect]) rider.requiresEffect = raw.requiresEffect;
  return rider;
}

function normalizeRiders(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_RIDERS).map(normalizeRider).filter(Boolean);
}

function normalizeResources(raw) {
  const resources = {};
  if (!isRecord(raw)) return resources;
  for (const [key, value] of Object.entries(raw).slice(0, MAX_RESOURCES)) {
    if (!RESOURCE_KEY_RE.test(key) || !isRecord(value)) continue;
    const max = clamp(value.max, 0, 999, 0);
    resources[key] = {
      name: label(value.name, 40) || key,
      max,
      current: clamp(value.current, 0, max, max),
      recharge: RECHARGES.has(value.recharge) ? value.recharge : 'short'
    };
  }
  return resources;
}

// A damage spell the tracker can cast: an attack roll or a save, with the
// area it covers (public/js/shared/aoe.js rules on who is caught).
const ZONE_TRIGGERS = new Set(['start', 'enter', 'both']);
function normalizeSpellLight(raw) {
  if (!isRecord(raw)) return null;
  const light = { bright: clamp(raw.bright, 0, 300, 0), dim: clamp(raw.dim, 0, 300, 0), dark: clamp(raw.dark, 0, 300, 0) };
  return light.bright || light.dim || light.dark ? light : null;
}

// A thing a spell puts on the map and its caster then moves about (Mage Hand,
// Spiritual Weapon): what it is, how far from the caster it may be (`leashFt`,
// 0 = anywhere), how far it moves in a turn, whether it attacks (`strike`: the
// spell's damage with the caster's spell attack) and the light it sheds.
const SUMMON_KINDS = new Set(['hand', 'weapon', 'lights', 'servant', 'disk']);
function normalizeSummon(raw) {
  if (!isRecord(raw) || !SUMMON_KINDS.has(raw.kind)) return null;
  const summon = { kind: raw.kind, leashFt: clamp(raw.leashFt, 0, 600, 0), moveFt: clamp(raw.moveFt, 0, 120, 30) };
  if (raw.strike === true) summon.strike = true;
  const light = normalizeSpellLight(raw.light);
  if (light) summon.light = light;
  return summon;
}

// Areas that linger in a fight (`combat.zones`, public): the resolved aim
// (shared/aoe.js numbers), what a creature caught in it saves against, and
// `touched` — who it has already caught this turn.
function normalizeZones(raw, combatantIds) {
  const known = new Set(combatantIds);
  const point = (value) => ({ x: clamp100(value && value.x), z: clamp100(value && value.z) });
  const zones = [];
  for (const source of (Array.isArray(raw) ? raw : []).slice(0, MAX_ZONES)) {
    if (!isRecord(source) || !isRecord(source.aim) || !ABILITY_AREAS.has(source.aim.kind)) continue;
    const sourceId = label(source.sourceId, 80);
    if (!known.has(sourceId)) continue;
    const zone = {
      id: label(source.id, 24) || `z${zones.length}`,
      sourceId, sourceName: label(source.sourceName, 40) || 'Someone',
      name: label(source.name, 40) || 'Area',
      aim: {
        kind: source.aim.kind, size: Math.max(0, Math.min(200, Number(source.aim.size) || 0)),
        width: Math.max(0, Math.min(200, Number(source.aim.width) || 0)),
        origin: point(source.aim.origin), center: point(source.aim.center), dir: point(source.aim.dir)
      },
      on: ZONE_TRIGGERS.has(source.on) ? source.on : 'both',
      saveAbility: ABILITIES.includes(source.saveAbility) ? source.saveAbility : 'dex',
      dc: clamp(source.dc, 1, 40, 10),
      saveSuccess: source.saveSuccess === 'none' ? 'none' : 'half',
      damage: damageExpr(source.damage), damageType: label(source.damageType, 20),
      touched: (Array.isArray(source.touched) ? source.touched : []).slice(0, 64).map(id => label(id, 80)).filter(id => known.has(id))
    };
    if (CONDITION_LABELS[source.effect] && source.effect !== 'down') zone.effect = source.effect;
    if (source.follow === true) zone.follow = true;
    if (source.held === true) zone.held = true;
    const until = clamp(source.until, 1, 1000000, null);
    if (until != null) zone.until = until;
    zones.push(zone);
  }
  return zones;
}
function clamp100(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(-1e7, Math.min(1e7, number)) * 100) / 100 : 0;
}

function normalizeSpells(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_SPELLS).map((source, index) => {
    const spell = isRecord(source) ? source : {};
    const normalized = {
      name: label(spell.name, 40) || 'Spell',
      level: clamp(spell.level, 0, 9, 0),
      damage: label(String(spell.damage == null ? '' : spell.damage), 20),
      damageType: label(spell.damageType, 20),
      spellIndex: index
    };
    // A spell may lay a condition instead of (or with) its damage.
    const effect = CONDITION_LABELS[spell.effect] && spell.effect !== 'down' ? spell.effect : null;
    const heal = damageExpr(spell.heal); // hit points given back instead of taken
    const summon = normalizeSummon(spell.summon);
    if (effect) normalized.effect = effect;
    if (summon) { normalized.summon = summon; if (!summon.strike) normalized.damage = ''; }
    else if (heal) { normalized.heal = heal; normalized.damage = ''; }
    else if (!effect && !normalized.damage && !normalizeSpellLight(spell.light)) normalized.damage = '1d4';
    if (SPELL_FORMS.has(spell.form)) normalized.form = spell.form;
    // A light it puts on a creature (Light, Daylight) or a darkness (`dark`), in feet.
    const light = normalizeSpellLight(spell.light);
    if (light) { normalized.light = light; if (!heal && !effect) normalized.damage = ''; }
    // An area that stays: who it catches later (`on`), whether it also rolls
    // when cast (`initial`), whether it moves with its caster (`follow`).
    if (isRecord(spell.zone) && spell.saveAbility) {
      normalized.zone = {
        on: ZONE_TRIGGERS.has(spell.zone.on) ? spell.zone.on : 'both',
        ...(spell.zone.initial === true ? { initial: true } : {}),
        ...(spell.zone.follow === true ? { follow: true } : {})
      };
    }
    if (spell.time === 'bonus') normalized.time = 'bonus';
    if (summon && spell.concentration !== true) {
      const rounds = clamp(spell.rounds, 1, 14400, null);
      if (rounds != null) normalized.rounds = rounds;
    }
    if (spell.concentration === true) {
      normalized.concentration = true;
      const rounds = clamp(spell.rounds, 1, 14400, null);
      if (rounds != null) normalized.rounds = rounds;
    }
    if (isRecord(spell.bySlot)) {
      const bySlot = {};
      for (let level = 1; level <= 9; level++) {
        const expr = damageExpr(spell.bySlot[level]);
        if (expr) bySlot[level] = expr;
      }
      if (Object.keys(bySlot).length) normalized.bySlot = bySlot;
    }
    if (summon) {
      // Placed at a point: nothing is rolled when it is cast.
    } else if (spell.saveAbility) {
      normalized.saveAbility = ABILITIES.includes(spell.saveAbility) ? spell.saveAbility : 'dex';
      normalized.saveSuccess = spell.saveSuccess === 'none' ? 'none' : 'half';
    } else if ((effect || heal || normalizeSpellLight(spell.light)) && !normalized.damage) {
      // No roll at all: the caster picks who gets it (Bless, Invisibility).
      normalized.maxTargets = clamp(spell.maxTargets, 1, 12, 1);
    } else {
      normalized.attackType = spell.attackType === 'melee' ? 'melee' : 'ranged';
    }
    const rangeFt = clamp(spell.rangeFt, 0, 600, null);
    if (rangeFt != null) normalized.rangeFt = rangeFt;
    if (ABILITY_AREAS.has(spell.area) && spell.area !== 'single') {
      normalized.area = spell.area;
      normalized.areaFt = clamp(spell.areaFt, 0, 300, 0);
    }
    return normalized;
  });
}

// What changes a combatant's own saving throws, from its sheet: advantage on
// some abilities (Danger Sense), a flat bonus to all of them (Aura of
// Protection) and Evasion. Conditions add theirs when the save is rolled.
function normalizeSaveMods(raw) {
  const source = isRecord(raw) ? raw : {};
  const mods = {};
  const advantage = (Array.isArray(source.advantage) ? source.advantage : []).filter(a => ABILITIES.includes(a));
  if (advantage.length) mods.advantage = [...new Set(advantage)];
  const bonus = clamp(source.bonus, -10, 20, 0);
  if (bonus) mods.bonus = bonus;
  if (source.evasion === true) mods.evasion = true;
  if (source.concentration === true) mods.concentration = true;
  return mods;
}

// Saving throws waiting to be rolled (a fireball caught six creatures: its
// damage is rolled once, each of the six rolls its own save). Rebuilt field by
// field so a persisted record can be trusted again after a restart.
function normalizePending(raw, combatantIds) {
  const known = new Set(combatantIds);
  const list = [];
  for (const source of (Array.isArray(raw) ? raw : []).slice(0, MAX_PENDING)) {
    if (!isRecord(source) || !isRecord(source.targets)) continue;
    const targets = {};
    for (const [id, value] of Object.entries(source.targets).slice(0, 64)) {
      if (!known.has(id) || !isRecord(value)) continue;
      const done = value.done === true;
      targets[id] = done
        ? { done: true, success: value.success === true, total: clamp(value.total, -50, 100, 0) }
        : { done: false };
    }
    if (!Object.values(targets).some(target => !target.done)) continue;
    const pending = {
      id: label(source.id, 24) || `p${list.length}`,
      sourceId: label(source.sourceId, 80),
      sourceName: label(source.sourceName, 40) || 'Someone',
      name: label(source.name, 40) || 'Effect',
      verb: source.verb === 'casts' ? 'casts' : 'uses',
      saveAbility: ABILITIES.includes(source.saveAbility) ? source.saveAbility : 'dex',
      dc: clamp(source.dc, 1, 40, 10),
      saveSuccess: source.saveSuccess === 'none' ? 'none' : 'half',
      damageType: label(source.damageType, 20),
      targets
    };
    if (isRecord(source.damage)) {
      pending.damage = {
        expr: label(String(source.damage.expr == null ? '' : source.damage.expr), 20),
        rolls: (Array.isArray(source.damage.rolls) ? source.damage.rolls : []).slice(0, 80).map(roll => clamp(roll, 0, 1000, 0)),
        total: clamp(source.damage.total, 0, 9999, 0)
      };
    }
    if (CONDITION_LABELS[source.effect] && source.effect !== 'down') pending.effect = source.effect;
    if (source.linked === true) pending.linked = true;
    if (source.conc === true) pending.conc = true;
    list.push(pending);
  }
  return list;
}

// The spell a combatant concentrates on, and the conditions it holds on
// others: { name, effects: [{ id, key }], until? (the round it runs out) }.
function normalizeConcentration(raw) {
  if (!isRecord(raw)) return null;
  const name = label(raw.name, 40);
  if (!name) return null;
  const held = { name, effects: [] };
  for (const link of (Array.isArray(raw.effects) ? raw.effects : []).slice(0, 24)) {
    if (!isRecord(link) || !CONDITION_LABELS[link.key]) continue;
    const id = label(link.id, 80);
    if (id) held.effects.push({ id, key: link.key });
  }
  const until = clamp(raw.until, 1, 1000000, null);
  if (until != null) held.until = until;
  // Tokens whose light (or darkness) this spell is.
  const lights = (Array.isArray(raw.lights) ? raw.lights : []).slice(0, 12).map(id => label(id, 80)).filter(Boolean);
  if (lights.length) held.lights = lights;
  return held;
}

// The per-turn action economy beyond the single action flag.
function normalizeTurnState(raw) {
  const source = isRecord(raw) ? raw : {};
  const state = {
    attacksPerAction: clamp(source.attacksPerAction, 1, 4, 1),
    critRange: clamp(source.critRange, 18, 20, 20),
    bonusUsed: source.bonusUsed === true,
    attacksLeft: clamp(source.attacksLeft, 0, 4, 0),
    bonusAttacks: null,
    ridersUsed: (Array.isArray(source.ridersUsed) ? source.ridersUsed : []).slice(0, MAX_RIDERS)
      .map(index => clamp(index, 0, MAX_RIDERS - 1, null)).filter(index => index != null)
  };
  if (isRecord(source.bonusAttacks)) {
    const count = clamp(source.bonusAttacks.count, 0, 4, 0);
    if (count > 0) state.bonusAttacks = { count, only: label(source.bonusAttacks.only, 30) };
  }
  return state;
}

// Can this rider add its dice to this attack right now?
function riderApplies(rider, attack, combatant, ridersUsed, index) {
  if (!rider) return false;
  if (rider.oncePerTurn && ridersUsed.includes(index)) return false;
  if (rider.requiresEffect && !(combatant.effects || []).some(e => e.key === rider.requiresEffect)) return false;
  const tags = Array.isArray(attack.tags) ? attack.tags : [attack.ranged ? 'ranged' : 'melee'];
  switch (rider.applies) {
    case 'melee': return tags.includes('melee');
    case 'ranged': return tags.includes('ranged');
    case 'unarmed': return tags.includes('unarmed');
    case 'finesse-or-ranged': return tags.includes('finesse') || tags.includes('ranged');
    default: return true;
  }
}

module.exports = {
  CONDITION_LABELS, MAX_ABILITIES,
  normalizeAttacks, normalizeAbilities, normalizeRiders, normalizeResources,
  SPELL_FORMS, SUMMON_KINDS, normalizeSummon, normalizeSpells, normalizeZones, normalizeSaveMods, normalizePending, normalizeConcentration,
  normalizeTurnState, riderApplies, damageExpr
};
