// srd.js — D&D 5e SRD data loader + rules helpers (ES module).
// Data: SRD 5.1 (CC-BY-4.0) via 5e-bits/5e-database. See data/srd/ATTRIBUTION.md.

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES = {
  str: 'Strength', dex: 'Dexterity', con: 'Constitution',
  int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma'
};
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;

const FULL_CASTERS = ['bard', 'cleric', 'druid', 'sorcerer', 'wizard'];
const HALF_CASTERS = ['paladin', 'ranger'];
// PHB multiclass spellcaster slots: combined caster level -> [L1..L9]
const MULTI_SLOTS = {
  1:[2,0,0,0,0,0,0,0,0], 2:[3,0,0,0,0,0,0,0,0], 3:[4,2,0,0,0,0,0,0,0], 4:[4,3,0,0,0,0,0,0,0],
  5:[4,3,2,0,0,0,0,0,0], 6:[4,3,3,0,0,0,0,0,0], 7:[4,3,3,1,0,0,0,0,0], 8:[4,3,3,2,0,0,0,0,0],
  9:[4,3,3,3,1,0,0,0,0], 10:[4,3,3,3,2,0,0,0,0], 11:[4,3,3,3,2,1,0,0,0], 12:[4,3,3,3,2,1,0,0,0],
  13:[4,3,3,3,2,1,1,0,0], 14:[4,3,3,3,2,1,1,0,0], 15:[4,3,3,3,2,1,1,1,0], 16:[4,3,3,3,2,1,1,1,0],
  17:[4,3,3,3,2,1,1,1,1], 18:[4,3,3,3,3,1,1,1,1], 19:[4,3,3,3,3,2,1,1,1], 20:[4,3,3,3,3,2,2,1,1]
};

export const abilityMod = (score) => Math.floor((score - 10) / 2);
export const fmtMod = (n) => (n >= 0 ? '+' + n : '' + n);
export const proficiencyBonus = (totalLevel) => 2 + Math.floor((Math.max(1, totalLevel) - 1) / 4);

// A proficiency index like "skill-acrobatics" maps to skill index "acrobatics".
export const profToSkill = (idx) => (idx && idx.startsWith('skill-') ? idx.slice(6) : null);

const FILES = {
  classes: 'classes', subclasses: 'subclasses', races: 'races', subraces: 'subraces',
  backgrounds: 'backgrounds', levels: 'levels', features: 'features', skills: 'skills',
  abilityScores: 'ability-scores', alignments: 'alignments', languages: 'languages',
  proficiencies: 'proficiencies', equipment: 'equipment', spells: 'spells'
};

let _cache = null;

export async function loadSRD(base = '/data/srd') {
  if (_cache) return _cache;
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, file]) => {
      const res = await fetch(`${base}/${file}.json`);
      if (!res.ok) throw new Error(`Failed to load ${file}.json (${res.status})`);
      return [key, await res.json()];
    })
  );
  _cache = new SRD(Object.fromEntries(entries));
  return _cache;
}

class SRD {
  constructor(data) {
    Object.assign(this, data); // this.classes, this.races, ...
    this._maps = {};
    for (const key of Object.keys(FILES)) {
      const m = new Map();
      for (const item of this[key]) m.set(item.index, item);
      this._maps[key] = m;
    }
    this._subclassLevel = this._computeSubclassLevels();
  }

  get(coll, idx) { return this._maps[coll] ? this._maps[coll].get(idx) : undefined; }

  // Merge shared homebrew (custom races/classes) into the SRD collections.
  setHomebrew(hb) {
    this.races = this.races.filter(r => !r.custom);
    this.classes = this.classes.filter(c => !c.custom);
    for (const r of (hb && hb.races) || []) { r.custom = true; this.races.push(r); }
    for (const c of (hb && hb.classes) || []) { c.custom = true; this.classes.push(c); }
    this._maps.races = new Map(this.races.map(x => [x.index, x]));
    this._maps.classes = new Map(this.classes.map(x => [x.index, x]));
  }

  // Level at which each class chooses its subclass (min level of any subclass feature).
  _computeSubclassLevels() {
    const out = {};
    for (const f of this.features) {
      if (f.subclass && f.class) {
        const c = f.class.index;
        out[c] = Math.min(out[c] ?? 99, f.level || 99);
      }
    }
    return out;
  }
  subclassChoiceLevel(classIdx) { return this._subclassLevel[classIdx] || 3; }
  subclassesForClass(classIdx) {
    return this.subclasses.filter(s => s.class && s.class.index === classIdx);
  }
  subracesForRace(raceIdx) {
    return this.subraces.filter(s => s.race && s.race.index === raceIdx);
  }

  // The class's skill proficiency choice group -> { choose, options:[skillIdx] } | null
  classSkillChoice(classIdx) {
    const cls = this.get('classes', classIdx);
    if (!cls) return null;
    for (const grp of cls.proficiency_choices || []) {
      const opts = (grp.from && grp.from.options) || [];
      const skills = opts.map(o => o.item && profToSkill(o.item.index)).filter(Boolean);
      if (skills.length) return { choose: grp.choose, options: skills };
    }
    return null;
  }

  // Fixed + optional skill grants from a race.
  raceSkillGrants(raceIdx) {
    const race = this.get('races', raceIdx);
    const fixed = [], choice = this._skillOptionGroup(race && race.starting_proficiency_options);
    for (const p of (race && race.starting_proficiencies) || []) {
      const s = profToSkill(p.index); if (s) fixed.push(s);
    }
    return { fixed, choice };
  }
  backgroundSkillGrants(bgIdx) {
    const bg = this.get('backgrounds', bgIdx);
    const fixed = [];
    for (const p of (bg && bg.starting_proficiencies) || []) {
      const s = profToSkill(p.index); if (s) fixed.push(s);
    }
    return fixed;
  }
  _skillOptionGroup(group) {
    if (!group || !group.from || !group.from.options) return null;
    const skills = group.from.options.map(o => o.item && profToSkill(o.item.index)).filter(Boolean);
    return skills.length ? { choose: group.choose, options: skills } : null;
  }

  // --- Racial ability bonuses -------------------------------------------------
  // Returns { fixed: {abil:bonus}, options: {choose, from:[abil]} | null }
  racialAbilityBonuses(raceIdx, subraceIdx) {
    const fixed = {};
    const add = (list) => {
      for (const b of list || []) {
        const a = b.ability_score && b.ability_score.index;
        if (a) fixed[a] = (fixed[a] || 0) + b.bonus;
      }
    };
    const race = this.get('races', raceIdx);
    add(race && race.ability_bonuses);
    if (subraceIdx) add(this.get('subraces', subraceIdx)?.ability_bonuses);
    let options = null;
    const opt = race && race.ability_bonus_options;
    if (opt && opt.from && opt.from.options) {
      options = { choose: opt.choose, from: opt.from.options.map(o => o.ability_score && o.ability_score.index).filter(Boolean) };
    }
    return { fixed, options };
  }

  // Final ability scores = base + fixed racial + chosen racial (+1 each).
  finalAbilities(base, raceIdx, subraceIdx, chosen = []) {
    const out = { ...base };
    const { fixed } = this.racialAbilityBonuses(raceIdx, subraceIdx);
    for (const a of ABILITIES) out[a] = (out[a] || 8) + (fixed[a] || 0);
    for (const a of chosen) out[a] = (out[a] || 8) + 1;
    return out;
  }

  // --- Derived combat stats ---------------------------------------------------
  totalLevel(classes) { return (classes || []).reduce((s, c) => s + (c.level || 0), 0); }

  maxHP(classes, conMod) {
    let hp = 0, first = true;
    for (const c of classes || []) {
      const hd = this.get('classes', c.class)?.hit_die || 8;
      for (let l = 0; l < (c.level || 0); l++) {
        hp += (first ? hd : Math.floor(hd / 2) + 1) + conMod;
        first = false;
      }
    }
    return Math.max(hp, 1);
  }
  baseAC(dexMod) { return 10 + dexMod; }

  // Save proficiencies come from the FIRST (initial) class only (PHB multiclass rule).
  saveProficiencies(classes) {
    const first = classes && classes[0] && this.get('classes', classes[0].class);
    return new Set((first ? first.saving_throws : []).map(s => s.index));
  }

  speed(raceIdx) { return this.get('races', raceIdx)?.speed || 30; }

  // --- Equipment ---
  equipmentByCategory(cat) { return this.equipment.filter(e => e.equipment_category && e.equipment_category.index === cat); }
  armorList() { return this.equipmentByCategory('armor').filter(a => a.armor_category !== 'Shield'); }
  weaponList() { return this.equipmentByCategory('weapon'); }
  gearList() { return this.equipmentByCategory('adventuring-gear'); }

  armorClass({ armorIdx, shield, dexMod, classes, conMod, wisMod }) {
    let ac, source;
    const armor = armorIdx && this.get('equipment', armorIdx);
    if (armor && armor.armor_class) {
      const acd = armor.armor_class;
      let dex = acd.dex_bonus ? dexMod : 0;
      if (acd.dex_bonus && acd.max_bonus != null) dex = Math.min(dex, acd.max_bonus);
      ac = acd.base + dex; source = armor.name;
    } else if ((classes || []).some(c => c.class === 'barbarian')) {
      ac = 10 + dexMod + conMod; source = 'Unarmored Defense (Barbarian)';
    } else if ((classes || []).some(c => c.class === 'monk') && !shield) {
      // Monk Unarmored Defense requires no shield (unlike Barbarian's).
      ac = 10 + dexMod + wisMod; source = 'Unarmored Defense (Monk)';
    } else {
      ac = 10 + dexMod; source = 'Unarmored';
    }
    if (shield) { ac += 2; source += ' + shield'; }
    return { ac, source };
  }

  weaponProficient(classes, weapon) {
    for (const c of classes || []) {
      const cl = this.get('classes', c.class);
      const profs = ((cl && cl.proficiencies) || []).map(p => p.index);
      if (weapon.weapon_category === 'Simple' && profs.includes('simple-weapons')) return true;
      if (weapon.weapon_category === 'Martial' && profs.includes('martial-weapons')) return true;
      // Specific-weapon grants: class profs are plural ("daggers"); resolve to the
      // singular equipment index via the proficiency's reference (proficiencies.json).
      if (profs.some(p => p === weapon.index || this.get('proficiencies', p)?.reference?.index === weapon.index)) return true;
    }
    return false;
  }
  weaponAttack(weapon, mods, classes, profBonus) {
    const props = (weapon.properties || []).map(p => p.index);
    const ranged = weapon.weapon_range === 'Ranged';
    let abil = ranged ? 'dex' : 'str';
    if (props.includes('finesse')) abil = (mods.dex >= mods.str) ? 'dex' : 'str';
    const m = mods[abil] || 0;
    const modStr = m ? (m > 0 ? '+' + m : '' + m) : '';
    const prof = this.weaponProficient(classes, weapon) ? profBonus : 0;
    const dd = weapon.damage ? weapon.damage.damage_dice : '—';
    const dt = weapon.damage && weapon.damage.damage_type ? weapon.damage.damage_type.name : '';
    const versatile = (props.includes('versatile') && weapon.two_handed_damage) ? weapon.two_handed_damage.damage_dice + modStr : null;
    const range = weapon.range ? ((ranged && weapon.range.long) ? `${weapon.range.normal}/${weapon.range.long} ft` : `${weapon.range.normal} ft`) : '';
    return { attack: m + prof, damage: dd + modStr, damageType: dt, ranged, versatile, range };
  }

  // --- Spellcasting ---
  isCaster(classIdx) { const c = this.get('classes', classIdx); return !!(c && c.spellcasting); }
  spellcastingAbility(classIdx) { const c = this.get('classes', classIdx); return c && c.spellcasting ? c.spellcasting.spellcasting_ability.index : null; }
  spellsForClass(classIdx) {
    // Custom caster classes borrow an existing class's spell list.
    const cls = this.get('classes', classIdx);
    const src = (cls && cls.custom) ? (cls.spellList || (this.casterType(classIdx) ? 'wizard' : classIdx)) : classIdx;
    return this.spells.filter(s => (s.classes || []).some(c => c.index === src))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }
  casterType(classIdx) {
    const c = this.get('classes', classIdx);
    if (c && c.custom) return (c.caster === 'full' || c.caster === 'half') ? c.caster : null;
    if (FULL_CASTERS.includes(classIdx)) return 'full';
    if (HALF_CASTERS.includes(classIdx)) return 'half';
    if (classIdx === 'warlock') return 'pact';
    return null;
  }
  classLevelData(classIdx, level) {
    return this.levels.find(l => l.class && l.class.index === classIdx && l.level === level && !l.subclass);
  }
  spellSlots(classes) {
    const casters = (classes || []).filter(c => this.isCaster(c.class));
    const slots = {}; for (let i = 1; i <= 9; i++) slots[i] = 0;
    let pact = null;
    const warlock = (classes || []).find(c => c.class === 'warlock');
    if (warlock) {
      const ld = this.classLevelData('warlock', warlock.level);
      if (ld && ld.spellcasting) {
        let lvl = 0, count = 0;
        for (let i = 1; i <= 9; i++) { const n = ld.spellcasting['spell_slots_level_' + i] || 0; if (n) { lvl = i; count = n; } }
        if (count) pact = { level: lvl, count };
      }
    }
    const nonWarlock = casters.filter(c => c.class !== 'warlock');
    const allStandard = nonWarlock.every(c => !this.get('classes', c.class)?.custom);
    if (nonWarlock.length === 1 && allStandard) {
      // Single standard caster: use the exact per-level table from the SRD.
      const c = nonWarlock[0]; const ld = this.classLevelData(c.class, c.level);
      if (ld && ld.spellcasting) for (let i = 1; i <= 9; i++) slots[i] = ld.spellcasting['spell_slots_level_' + i] || 0;
    } else if (nonWarlock.length >= 1) {
      // Multiclass and/or custom casters: combined caster level via the standard table.
      let cl = 0;
      for (const c of nonWarlock) { const t = this.casterType(c.class); if (t === 'full') cl += c.level; else if (t === 'half') cl += Math.floor(c.level / 2); }
      if (cl >= 1) { const row = MULTI_SLOTS[Math.min(cl, 20)] || []; for (let i = 1; i <= 9; i++) slots[i] = row[i - 1] || 0; }
    }
    return { slots, pact, casters: casters.map(c => ({ class: c.class, ability: this.spellcastingAbility(c.class) })) };
  }

  // Cantrips known + spells known/prepared cap for one caster class at a level.
  // Known casters (bard/ranger/sorcerer/warlock) use spells_known from the SRD;
  // prepared casters compute their cap from ability mod + level (paladin: +half level).
  spellLimits(classIdx, level, abilityMod) {
    const cls = this.get('classes', classIdx);
    if (cls && cls.custom) {
      const t = this.casterType(classIdx);
      if (!t) return { cantrips: 0, known: null, prepared: false };
      const eff = t === 'half' ? Math.floor(level / 2) : level;
      const cantrips = eff >= 1 ? (eff < 4 ? 2 : eff < 10 ? 3 : 4) : 0;
      const known = eff >= 1 ? Math.max(1, (abilityMod || 0) + eff) : 0;
      return { cantrips, known, prepared: true };
    }
    const sc = this.classLevelData(classIdx, level)?.spellcasting;
    const cantrips = sc && sc.cantrips_known != null ? sc.cantrips_known : 0;
    let known = null, prepared = false;
    if (sc && sc.spells_known != null) known = sc.spells_known;
    else if (classIdx === 'wizard' || classIdx === 'cleric' || classIdx === 'druid') { known = Math.max(1, (abilityMod || 0) + level); prepared = true; }
    else if (classIdx === 'paladin') { known = Math.floor(level / 2) >= 1 ? Math.max(1, (abilityMod || 0) + Math.floor(level / 2)) : 0; prepared = true; }
    return { cantrips, known, prepared };
  }

  // Features gained, grouped, across the build: [{class, level, name, desc}]
  classFeatures(classes) {
    const out = [];
    for (const c of classes || []) {
      const cls = this.get('classes', c.class);
      if (cls && cls.custom) {
        for (const f of cls.customFeatures || []) {
          if ((f.level || 1) <= (c.level || 0)) out.push({ class: c.class, level: f.level || 1, name: f.name, desc: f.desc || '' });
        }
        continue;
      }
      const subIdx = c.subclass;
      for (const f of this.features) {
        if (!f.class || f.class.index !== c.class) continue;
        if ((f.level || 0) > (c.level || 0)) continue;
        if (f.subclass && (!subIdx || f.subclass.index !== subIdx)) continue;
        out.push({ class: c.class, level: f.level, name: f.name, desc: (f.desc || []).join(' ') });
      }
    }
    return out.sort((a, b) => a.level - b.level);
  }
}
