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

export const abilityMod = (score) => Math.floor((score - 10) / 2);
export const fmtMod = (n) => (n >= 0 ? '+' + n : '' + n);
export const proficiencyBonus = (totalLevel) => 2 + Math.floor((Math.max(1, totalLevel) - 1) / 4);

// A proficiency index like "skill-acrobatics" maps to skill index "acrobatics".
export const profToSkill = (idx) => (idx && idx.startsWith('skill-') ? idx.slice(6) : null);

const FILES = {
  classes: 'classes', subclasses: 'subclasses', races: 'races', subraces: 'subraces',
  backgrounds: 'backgrounds', levels: 'levels', features: 'features', skills: 'skills',
  abilityScores: 'ability-scores', alignments: 'alignments', languages: 'languages',
  proficiencies: 'proficiencies'
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

  // Features gained, grouped, across the build: [{class, level, name, desc}]
  classFeatures(classes) {
    const out = [];
    for (const c of classes || []) {
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
