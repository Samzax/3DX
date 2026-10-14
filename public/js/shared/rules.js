// rules.js — the feature-mechanics interpreter shared by the creator, the
// player sheet and combat. Pure (no three.js/DOM; importable in Node).
//
// Every race trait, class/subclass feature, background feature, feat and
// magic item is normalised to one "feature" shape (see lib/homebrew.cjs):
//   grants   — passive numbers (ability bonuses, skills, AC, speed, …)
//   action   — something usable in combat (attack / save / heal / utility)
//   rider    — extra damage on weapon attacks (Sneak Attack, Rage)
//   resource — a pool spent by actions (Ki, Rage uses)
//   choice   — pick N option features
// Homebrew carries those blocks as data; the SRD features that need them get
// them from SRD_MECHANICS below (the SRD JSON only has prose). buildSheet()
// turns a character into derived numbers plus a combat kit the server can run.

import { ABILITIES, abilityMod, proficiencyBonus } from './srd.js';

const ALL_SKILLS = [];

// Conditions a feature may apply (mirrors lib/combat-kit.cjs CONDITION_LABELS,
// minus "down", which only HP sets). Kept here so DOM-free pages can list them.
export const CONDITION_NAMES = {
    prone: 'Prone', poisoned: 'Poisoned', restrained: 'Restrained', stunned: 'Stunned',
    blinded: 'Blinded', frightened: 'Frightened', grappled: 'Grappled', invisible: 'Invisible',
    raging: 'Raging', hidden: 'Hidden', blessed: 'Blessed', paralyzed: 'Paralyzed',
    dodging: 'Dodge', disengaged: 'Disengage', dashed: 'Dash'
};

// --- Tiny expression language -------------------------------------------------
// Counts and dice bonuses may reference the character: level, classLevel, prof
// and the ability modifiers str..cha. Only + - * / and parentheses; results
// floor. Hand-parsed — homebrew text never reaches eval().
export function evalFormula(expr, ctx = {}) {
    const src = String(expr == null ? '' : expr).replace(/\s+/g, '');
    if (!src) return 0;
    let pos = 0;
    const peek = () => src[pos];
    function primary() {
        if (peek() === '(') { pos++; const v = sum(); if (peek() === ')') pos++; return v; }
        if (peek() === '-') { pos++; return -primary(); }
        const number = /^\d+(?:\.\d+)?/.exec(src.slice(pos));
        if (number) { pos += number[0].length; return Number(number[0]); }
        const ident = /^[A-Za-z]+/.exec(src.slice(pos));
        if (ident) {
            pos += ident[0].length;
            const value = ctx[ident[0]] ?? ctx[ident[0].toLowerCase()];
            return Number.isFinite(Number(value)) ? Number(value) : 0;
        }
        pos = src.length; // unknown character: stop parsing
        return 0;
    }
    function product() {
        let v = primary();
        while (peek() === '*' || peek() === '/') {
            const op = src[pos++]; const r = primary();
            v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
        }
        return v;
    }
    function sum() {
        let v = product();
        while (peek() === '+' || peek() === '-') {
            const op = src[pos++]; const r = product();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }
    const result = Math.floor(sum());
    return Number.isFinite(result) ? result : 0;
}

// "1d8+dex" → "1d8+3"; "classLevel*5" → "25". The server rolls "NdM±K" or a
// flat number, so every symbolic part is folded into one constant here.
export function resolveDice(expr, ctx = {}) {
    const src = String(expr == null ? '' : expr).replace(/\s+/g, '');
    if (!src) return '';
    const m = /^(\d+)d(\d+)(.*)$/i.exec(src);
    if (!m) return String(Math.max(0, evalFormula(src, ctx)));
    const bonus = m[3] ? evalFormula('0' + m[3], ctx) : 0;
    return `${m[1]}d${m[2]}${bonus > 0 ? '+' + bonus : bonus < 0 ? String(bonus) : ''}`;
}

// Highest scaling tier at or below `level` (class level for class features,
// character level for everything else).
export function scaledDamage(base, scaling, level) {
    let out = base || '';
    for (const tier of scaling || []) if (tier && tier.level <= level && tier.damage) out = tier.damage;
    return out;
}

const dieAverage = (dice) => {
    const m = /^(\d+)d(\d+)/i.exec(String(dice || ''));
    return m ? Number(m[1]) * (Number(m[2]) + 1) / 2 : Number(dice) || 0;
};

// --- SRD mechanics -----------------------------------------------------------
// index → (ctx) => partial feature. ctx: { classLevel, level, spec (the SRD
// class_specific row for that class level), vars (set by chosen options) }.
// `actions` may hold several entries; `hide` drops a feature from the sheet
// (it is offered as a choice option of its parent instead).
const DRAGONS = [
    ['Black', 'acid', 'line', 30, 'dex'], ['Blue', 'lightning', 'line', 30, 'dex'],
    ['Brass', 'fire', 'line', 30, 'dex'], ['Bronze', 'lightning', 'line', 30, 'dex'],
    ['Copper', 'acid', 'line', 30, 'dex'], ['Gold', 'fire', 'cone', 15, 'dex'],
    ['Green', 'poison', 'cone', 15, 'con'], ['Red', 'fire', 'cone', 15, 'dex'],
    ['Silver', 'cold', 'cone', 15, 'con'], ['White', 'cold', 'cone', 15, 'con']
];
const kiAction = (name, extra) => ({ name, type: 'utility', cost: 'bonus', area: 'self', resource: 'ki', resourceCost: 1, ...extra });
const extraAttack = (count) => () => ({ grants: { attacksPerAction: count } });
const fightingStyle = (prefix) => (ctx) => ({
    choice: {
        choose: 1,
        options: ctx.SRD.features.filter(f => f.index.startsWith(prefix) && f.index !== prefix.slice(0, -1)).map(f => ({
            name: f.name.replace(/^Fighting Style:\s*/i, ''),
            desc: (f.desc || []).join(' '),
            ...(/defense$/.test(f.index) ? { grants: { ac: 1 } } : {})
        }))
    }
});
const hidden = () => ({ hide: true });

export const SRD_MECHANICS = {
    // Races
    'darkvision': () => ({ grants: { darkvision: 60 } }),
    'dwarven-resilience': () => ({ grants: { resistances: ['poison'] } }),
    'dwarven-toughness': () => ({ grants: { hpPerLevel: 1 } }),
    'hellish-resistance': () => ({ grants: { resistances: ['fire'] } }),
    'keen-senses': () => ({ grants: { skills: ['perception'] } }),
    'menacing': () => ({ grants: { skills: ['intimidation'] } }),
    'skill-versatility': () => ({ grants: { skillChoice: { choose: 2, from: [] } } }),
    'extra-language': () => ({ grants: { languageChoice: 1 } }),
    'draconic-ancestry': () => ({
        choice: {
            choose: 1,
            options: DRAGONS.map(([name, type, area, feet, save]) => ({
                name: `${name} (${type})`,
                desc: `${feet} ft. ${area}, ${save.toUpperCase()} save. Resistance to ${type} damage.`,
                grants: { resistances: [type] },
                set: { breathType: type, breathArea: area, breathFt: feet, breathSave: save }
            }))
        }
    }),
    'breath-weapon': (ctx) => ({
        actions: [{
            type: 'save', cost: 'action', damage: '2d6',
            scaling: [{ level: 6, damage: '3d6' }, { level: 11, damage: '4d6' }, { level: 16, damage: '5d6' }],
            damageType: ctx.vars.breathType || 'fire', saveAbility: ctx.vars.breathSave || 'dex',
            saveSuccess: 'half', dcAbility: 'con', area: ctx.vars.breathArea || 'cone',
            areaFt: ctx.vars.breathFt || 15, rangeFt: ctx.vars.breathFt || 15, maxTargets: 6,
            uses: '1', recharge: 'short'
        }]
    }),
    'damage-resistance': hidden,

    // Rogue
    'sneak-attack': () => ({
        rider: {
            damage: '1d6', applies: 'finesse-or-ranged', oncePerTurn: true,
            scaling: [3, 5, 7, 9, 11, 13, 15, 17, 19].map(level => ({ level, damage: `${Math.ceil(level / 2)}d6` }))
        }
    }),
    'cunning-action': () => ({
        actions: [
            { name: 'Cunning Action: Dash', type: 'utility', cost: 'bonus', area: 'self', grant: 'dash' },
            { name: 'Cunning Action: Disengage', type: 'utility', cost: 'bonus', area: 'self', grant: 'disengage' },
            { name: 'Cunning Action: Hide', type: 'utility', cost: 'bonus', area: 'self', selfEffect: 'hidden' }
        ]
    }),
    'rogue-evasion': () => ({ grants: { evasion: true } }),
    'reliable-talent': () => ({ grants: { checkMinDie: 10 } }),
    'rogue-expertise-1': () => ({ grants: { expertiseChoice: 2 } }),
    'rogue-expertise-2': () => ({ grants: { expertiseChoice: 2 } }),

    // Monk
    'monk-unarmored-defense': () => ({ grants: { acFormula: { base: 10, abilities: ['dex', 'wis'], shield: false } } }),
    'martial-arts': (ctx) => ({
        grants: {
            unarmedDamage: `1d${(ctx.spec.martial_arts && ctx.spec.martial_arts.dice_value) || 4}`,
            unarmedFinesse: true, monkWeapons: true
        },
        actions: [{ name: 'Martial Arts: bonus strike', type: 'utility', cost: 'bonus', area: 'self', grant: 'attacks', grantCount: 1, grantAttack: 'Unarmed' }]
    }),
    'ki': () => ({ resource: { key: 'ki', name: 'Ki', max: 'classLevel', recharge: 'short' } }),
    'flurry-of-blows': () => ({ actions: [kiAction('Flurry of Blows', { grant: 'attacks', grantCount: 2, grantAttack: 'Unarmed' })] }),
    'patient-defense': () => ({ actions: [kiAction('Patient Defense', { grant: 'dodge' })] }),
    'step-of-the-wind': () => ({
        actions: [kiAction('Step of the Wind: Dash', { grant: 'dash' }), kiAction('Step of the Wind: Disengage', { grant: 'disengage' })]
    }),
    'unarmored-movement-1': (ctx) => ({ grants: { speed: ctx.spec.unarmored_movement || 10 } }),
    'stunning-strike': () => ({
        actions: [{
            type: 'save', cost: 'free', saveAbility: 'con', saveSuccess: 'none', dcAbility: 'wis',
            area: 'single', maxTargets: 1, rangeFt: 5, effect: 'stunned', resource: 'ki', resourceCost: 1
        }]
    }),
    'monk-extra-attack': extraAttack(2),
    'monk-evasion': () => ({ grants: { evasion: true } }),

    // Barbarian
    'barbarian-unarmored-defense': () => ({ grants: { acFormula: { base: 10, abilities: ['dex', 'con'], shield: true } } }),
    'rage': (ctx) => ({
        resource: { key: 'rage', name: 'Rage', max: String(ctx.spec.rage_count || (ctx.classLevel >= 20 ? 99 : 2)), recharge: 'long' },
        actions: [{ type: 'utility', cost: 'bonus', area: 'self', selfEffect: 'raging', resource: 'rage', resourceCost: 1 }],
        rider: { damage: String(ctx.spec.rage_damage_bonus || 2), applies: 'melee', requiresEffect: 'raging', auto: true, oncePerTurn: false }
    }),
    'fast-movement': () => ({ grants: { speed: 10 } }),
    'danger-sense': () => ({ grants: { saveAdvantage: ['dex'] } }),
    'indomitable-might': () => ({ grants: { checkFloor: ['str'] } }),
    'barbarian-extra-attack': extraAttack(2),

    // Fighter
    'second-wind': () => ({ actions: [{ type: 'heal', cost: 'bonus', area: 'self', damage: '1d10+classLevel', uses: '1', recharge: 'short' }] }),
    'action-surge-1-use': (ctx) => ({
        actions: [{ name: 'Action Surge', type: 'utility', cost: 'free', area: 'self', grant: 'action', uses: ctx.classLevel >= 17 ? '2' : '1', recharge: 'short' }]
    }),
    'extra-attack-1': extraAttack(2),
    'extra-attack-2': extraAttack(3),
    'extra-attack-3': extraAttack(4),
    'fighter-fighting-style': fightingStyle('fighter-fighting-style-'),

    // Paladin / Ranger
    'lay-on-hands': () => ({
        resource: { key: 'lay-on-hands', name: 'Lay on Hands', max: 'classLevel*5', recharge: 'long' },
        actions: [{ name: 'Lay on Hands (5 HP)', type: 'heal', cost: 'action', area: 'single', maxTargets: 1, rangeFt: 5, damage: '5', resource: 'lay-on-hands', resourceCost: 5 }]
    }),
    'paladin-extra-attack': extraAttack(2),
    'aura-of-protection': () => ({ grants: { saveBonus: 'cha' } }),
    'superior-hunters-defense-evasion': () => ({ grants: { evasion: true } }),
    'paladin-fighting-style': fightingStyle('fighting-style-'),
    'ranger-extra-attack': extraAttack(2),
    'ranger-fighting-style': fightingStyle('ranger-fighting-style-')
};
for (const prefix of ['fighter-fighting-style-', 'fighting-style-', 'ranger-fighting-style-']) {
    for (const style of ['archery', 'defense', 'dueling', 'great-weapon-fighting', 'protection', 'two-weapon-fighting']) {
        SRD_MECHANICS[prefix + style] = hidden;
    }
}

// --- Feature collection ------------------------------------------------------
const descText = (desc) => Array.isArray(desc) ? desc.join(' ') : String(desc || '');
const hasMechanics = (f) => !!(f.grants || f.action || (f.actions && f.actions.length) || f.rider || f.resource || f.choice);

function normalize(raw, meta, ctx) {
    const feature = {
        name: raw.name || 'Feature',
        desc: descText(raw.desc),
        level: raw.level || meta.level || 1,
        index: raw.index || null,
        source: meta.source, sourceLabel: meta.sourceLabel,
        scaleLevel: meta.scaleLevel, classIdx: meta.classIdx || null,
        grants: raw.grants || null,
        actions: raw.action ? [raw.action] : [],
        rider: raw.rider || null,
        resource: raw.resource || null,
        choice: raw.choice || null,
        prereq: raw.prereq || null,
        set: raw.set || null
    };
    // SRD prose features pick their mechanics up by index; homebrew data wins.
    const builtin = !hasMechanics(feature) && feature.index && SRD_MECHANICS[feature.index];
    if (builtin) {
        const extra = builtin({ ...ctx, classLevel: meta.scaleLevel, spec: meta.spec || {} }) || {};
        if (extra.hide) return null;
        if (extra.grants) feature.grants = extra.grants;
        if (extra.actions) feature.actions = extra.actions;
        if (extra.rider) feature.rider = extra.rider;
        if (extra.resource) feature.resource = extra.resource;
        if (extra.choice) feature.choice = extra.choice;
    }
    return feature;
}

// Raw feature lists per source, before level gates and choices are resolved.
function featureSources(char, SRD) {
    const sources = [];
    const classes = char.classes || [];
    const total = SRD.totalLevel(classes) || 1;
    const push = (source, sourceLabel, scaleLevel, list, extra = {}) => {
        if (list && list.length) sources.push({ source, sourceLabel, scaleLevel, list, ...extra });
    };
    const race = SRD.get('races', char.race);
    if (race) push(`race:${race.index}`, race.name, total, race.traits || []);
    const subrace = char.subrace && SRD.get('subraces', char.subrace);
    if (subrace) push(`subrace:${subrace.index}`, subrace.name, total, subrace.traits || subrace.racial_traits || []);
    for (const entry of classes) {
        const cls = SRD.get('classes', entry.class);
        if (!cls) continue;
        const level = entry.level || 1;
        const spec = (SRD.classLevelData(entry.class, level) || {}).class_specific || {};
        const own = cls.custom ? (cls.customFeatures || [])
            : SRD.features.filter(f => f.class && f.class.index === entry.class && !f.subclass);
        push(`class:${cls.index}`, cls.name, level, own.filter(f => (f.level || 1) <= level), { classIdx: cls.index, spec });
        const sub = entry.subclass && SRD.get('subclasses', entry.subclass);
        if (sub) {
            const list = sub.custom ? (sub.features || [])
                : SRD.features.filter(f => f.subclass && f.subclass.index === sub.index);
            push(`subclass:${sub.index}`, sub.name, level, list.filter(f => (f.level || 1) <= level), { classIdx: cls.index, spec });
        }
    }
    const background = SRD.get('backgrounds', char.background);
    if (background) {
        const list = background.features || (background.feature ? [background.feature] : []);
        push(`background:${background.index}`, background.name, total, list);
    }
    for (const idx of char.feats || []) {
        const feat = SRD.get('feats', idx);
        if (feat) push(`feat:${feat.index}`, 'Feat', total, [feat]);
    }
    const eq = char.equipment || {};
    for (const idx of [eq.armor, ...(eq.weapons || []), ...(eq.items || [])]) {
        const item = idx && SRD.get('equipment', idx);
        if (item && item.grants) push(`item:${item.index}`, item.name, total, [{ name: item.name, grants: item.grants }]);
    }
    return sources;
}

// → { features, choices }. features is the flat, level-gated list with chosen
// options expanded; choices lists every pick-N the character still owns.
export function collectFeatures(char, SRD) {
    const picked = (char && char.choices) || {};
    const features = [];
    const choices = [];
    const vars = {};
    const ctx = { SRD, vars, level: SRD.totalLevel(char.classes || []) || 1 };
    const sources = featureSources(char, SRD);
    // Pass 1 resolves choices so the options' `set` values (dragon ancestry →
    // breath damage type) are known before pass 2 builds the other features.
    const expand = (collect) => {
        for (const src of sources) {
            const byName = new Map();
            for (const raw of src.list) {
                const feature = normalize(raw, src, ctx);
                if (!feature) continue;
                // A later, higher-level row with the same name upgrades the
                // earlier one ("Martial Arts" d4 → d6) when it carries mechanics.
                const previous = byName.get(feature.name);
                if (previous && hasMechanics(feature) && feature.level >= previous.level) {
                    byName.set(feature.name, feature);
                } else if (!previous) {
                    byName.set(feature.name, feature);
                } else {
                    byName.set(feature.name + '#' + byName.size, feature);
                }
            }
            for (const feature of byName.values()) {
                collect(feature);
                if (!feature.choice) continue;
                const key = `${feature.source}|${feature.name}`;
                const names = (picked[key] || []).slice(0, feature.choice.choose);
                const chosen = feature.choice.options.filter(o => names.includes(o.name));
                if (collect === addFeature) {
                    choices.push({
                        key, name: feature.name, sourceLabel: feature.sourceLabel,
                        choose: feature.choice.choose, options: feature.choice.options, picked: chosen.map(o => o.name)
                    });
                }
                for (const option of chosen) {
                    const optionFeature = normalize({ ...option, name: `${feature.name}: ${option.name}`, level: feature.level }, src, ctx);
                    if (optionFeature) { optionFeature.choice = null; collect(optionFeature); }
                }
            }
        }
    };
    function addVars(feature) { if (feature.set) Object.assign(vars, feature.set); }
    function addFeature(feature) { features.push(feature); }
    expand(addVars);
    expand(addFeature);
    return { features, choices };
}

// Fold every feature's grants into one totals record.
export function aggregateGrants(features) {
    const g = {
        abilities: {}, skills: new Set(), expertise: new Set(), saves: new Set(),
        proficiencies: [], languages: [], resistances: [], immunities: [],
        expertiseChoice: 0, languageChoice: 0, skillChoices: [],
        speed: 0, speeds: {}, ac: 0, hpPerLevel: 0, initiative: 0, darkvision: 0,
        blindsight: 0, truesight: 0, tremorsense: 0, devilsSight: 0,
        attacksPerAction: 1, critRange: 20, acFormulas: [],
        unarmedDamage: null, unarmedFinesse: false, monkWeapons: false, initiativeProf: false, blind: false,
        saveAdvantage: [], saveBonuses: [], evasion: false, concentrationAdvantage: false, checkMinDie: 0, checkFloor: []
    };
    const addAll = (target, list) => { for (const v of list || []) if (!target.includes(v)) target.push(v); };
    for (const feature of features) {
        const src = feature.grants;
        if (!src) continue;
        for (const [a, v] of Object.entries(src.abilities || {})) g.abilities[a] = (g.abilities[a] || 0) + v;
        for (const s of src.skills || []) g.skills.add(s);
        for (const s of src.expertise || []) g.expertise.add(s);
        for (const s of src.saves || []) g.saves.add(s);
        addAll(g.proficiencies, src.proficiencies);
        addAll(g.languages, src.languages);
        addAll(g.resistances, src.resistances);
        addAll(g.immunities, src.immunities);
        g.expertiseChoice += src.expertiseChoice || 0;
        g.languageChoice += src.languageChoice || 0;
        if (src.skillChoice) g.skillChoices.push(src.skillChoice);
        g.speed += src.speed || 0;
        for (const [mode, v] of Object.entries(src.speeds || {})) g.speeds[mode] = Math.max(g.speeds[mode] || 0, v);
        g.ac += src.ac || 0;
        g.hpPerLevel += src.hpPerLevel || 0;
        g.initiative += src.initiative || 0;
        g.darkvision = Math.max(g.darkvision, src.darkvision || 0);
        for (const sense of ['blindsight', 'truesight', 'tremorsense', 'devilsSight']) {
            g[sense] = Math.max(g[sense], src[sense] || 0);
        }
        g.attacksPerAction = Math.max(g.attacksPerAction, src.attacksPerAction || 1);
        if (src.critRange) g.critRange = Math.min(g.critRange, src.critRange);
        if (src.acFormula) g.acFormulas.push({ ...src.acFormula, name: feature.name });
        if (src.unarmedDamage && dieAverage(src.unarmedDamage) >= dieAverage(g.unarmedDamage)) g.unarmedDamage = src.unarmedDamage;
        if (src.unarmedFinesse) g.unarmedFinesse = true;
        if (src.monkWeapons) g.monkWeapons = true;
        if (src.initiativeProf) g.initiativeProf = true;
        if (src.blind) g.blind = true;
        addAll(g.saveAdvantage, src.saveAdvantage);
        addAll(g.checkFloor, src.checkFloor);
        if (src.saveBonus) g.saveBonuses.push(String(src.saveBonus));
        if (src.evasion) g.evasion = true;
        if (src.concentrationAdvantage) g.concentrationAdvantage = true;
        g.checkMinDie = Math.max(g.checkMinDie, src.checkMinDie || 0);
    }
    return g;
}

// Does the character meet a feat/feature prerequisite? → { ok, reason }
export function meetsPrereq(prereq, sheet) {
    if (!prereq) return { ok: true, reason: '' };
    const misses = [];
    if (prereq.level && sheet.total < prereq.level) misses.push(`level ${prereq.level}`);
    for (const [ability, minimum] of Object.entries(prereq.abilities || {})) {
        if ((sheet.finals[ability] || 0) < minimum) misses.push(`${ability.toUpperCase()} ${minimum}`);
    }
    const reason = [misses.length ? 'Requires ' + misses.join(', ') : '', prereq.text || ''].filter(Boolean).join(' · ');
    return { ok: !misses.length, reason };
}

const isMonkWeapon = (w) => {
    const props = (w.properties || []).map(p => p.index);
    if (props.includes('monk') || w.index === 'shortsword') return true;
    return w.weapon_category === 'Simple' && w.weapon_range === 'Melee'
        && !props.includes('two-handed') && !props.includes('heavy');
};

// --- The derived sheet -------------------------------------------------------
// One derivation for the creator rail, the player HUD and combat, so a grant
// can never show on the sheet without also reaching the fight.
export function buildSheet(char, SRD) {
    if (!ALL_SKILLS.length) for (const s of SRD.skills || []) ALL_SKILLS.push(s.index);
    const base = char.abilities || char.baseAbilities || char.stats || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    const classes = char.classes || [];
    const total = SRD.totalLevel(classes) || 1;
    const prof = proficiencyBonus(total);
    const { features, choices } = collectFeatures(char, SRD);
    const grants = aggregateGrants(features);

    const finals = SRD.finalAbilities(base, char.race, char.subrace, char.racialChoice || [], typeof char.racialSpread === 'number' ? char.racialSpread : null);
    // Ability Score Improvements the player spent (char.asi) stop at 20 like
    // the rulebook says; feature grants stack on top of that.
    const asi = (char.asi && typeof char.asi === 'object') ? char.asi : {};
    for (const a of ABILITIES) {
        const scored = finals[a] || 8;
        const spent = Math.max(0, Math.min(12, Math.floor(Number(asi[a]) || 0)));
        const improved = Math.min(Math.max(20, scored), scored + spent);
        finals[a] = Math.max(1, Math.min(30, improved + (grants.abilities[a] || 0)));
    }
    const mods = {}; for (const a of ABILITIES) mods[a] = abilityMod(finals[a]);

    const saves = SRD.saveProficiencies(classes);
    for (const a of grants.saves) saves.add(a);

    const raceGrants = SRD.raceSkillGrants(char.race);
    const granted = new Set([...raceGrants.fixed, ...SRD.backgroundSkillGrants(char.background), ...grants.skills]);
    if (char.subrace) for (const s of SRD.raceSkillGrants(char.subrace, 'subraces').fixed) granted.add(s);
    const proficient = new Set([...granted, ...(char.skills || [])]);
    const expertise = new Set(grants.expertise);
    for (const s of (char.expertise || []).slice(0, grants.expertiseChoice)) if (proficient.has(s)) expertise.add(s);
    const skillBonus = (skill, ability) => mods[ability] + (proficient.has(skill) ? prof : 0) + (expertise.has(skill) ? prof : 0);

    // Armor class: worn armor, or the best unarmored formula on offer.
    const eq = char.equipment || {};
    const armor = eq.armor && SRD.get('equipment', eq.armor);
    let ac, acSource;
    if (armor && armor.armor_class) {
        const def = armor.armor_class;
        let dex = def.dex_bonus ? mods.dex : 0;
        if (def.dex_bonus && def.max_bonus != null) dex = Math.min(dex, def.max_bonus);
        ac = def.base + dex + (armor.bonus || 0); acSource = armor.name;
    } else {
        ac = 10 + mods.dex; acSource = 'Unarmored';
        for (const f of grants.acFormulas) {
            if (eq.shield && !f.shield) continue;
            const value = f.base + (f.abilities || []).reduce((sum, a) => sum + (mods[a] || 0), 0);
            if (value > ac) { ac = value; acSource = f.name; }
        }
    }
    if (eq.shield) { ac += 2; acSource += ' + shield'; }
    ac += grants.ac;

    const race = SRD.get('races', char.race);
    const maxHP = SRD.maxHP(classes, mods.con) + grants.hpPerLevel * total;
    const speed = Math.max(0, SRD.speed(char.race) + grants.speed);
    const languages = [...new Set([
        ...((race && race.languages) || []).map(l => l.name || l.index),
        ...((SRD.get('backgrounds', char.background) || {}).languages || []).map(l => l.name || l.index).filter(Boolean),
        ...grants.languages, ...(char.languages || [])
    ])];
    const proficiencies = [...new Set([
        ...((SRD.get('backgrounds', char.background) || {}).tools || []), ...grants.proficiencies
    ])];
    // Homebrew backgrounds carry languageChoice; the SRD's use language_options.
    const background = SRD.get('backgrounds', char.background) || {};
    const languageChoice = grants.languageChoice
        + (background.languageChoice || (background.language_options && background.language_options.choose) || 0);

    const spellInfo = SRD.spellSlots(classes);
    spellInfo.casters.forEach(c => { c.dc = 8 + prof + (mods[c.ability] || 0); c.atk = prof + (mods[c.ability] || 0); });

    const sheet = {
        base, finals, mods, total, prof, saves, granted, proficient, expertise, skillBonus,
        maxHP, hp: maxHP, ac, acSource, speed, speeds: grants.speeds, init: mods.dex + grants.initiative + (grants.initiativeProf ? prof : 0),
        pp: 10 + skillBonus('perception', 'wis'),
        languages, languageChoice, proficiencies, darkvision: grants.darkvision,
        // Every special sense in feet, zeroes dropped — what a token sees with
        // on the map (shared/vision.js).
        // `blind`: no ordinary sight at all — only what those senses reach.
        senses: {
            ...Object.fromEntries(['darkvision', 'blindsight', 'truesight', 'tremorsense', 'devilsSight']
                .filter(sense => grants[sense] > 0).map(sense => [sense, grants[sense]])),
            ...(grants.blind ? { blind: true } : {})
        },
        resistances: grants.resistances, immunities: grants.immunities,
        // What bends this character's own d20s. Saves: advantage on some
        // abilities, a bonus to all, Evasion (the combat tracker applies them).
        // Checks: a proficient check's die reads at least `minDie`, and a
        // check with an ability in `floor` never totals less than that score.
        rollMods: {
            save: {
                advantage: grants.saveAdvantage.filter(a => ABILITIES.includes(a)),
                bonus: grants.saveBonuses.reduce((sum, expr) => sum + Math.max(0, evalFormula(expr, { ...mods, level: total, classLevel: total, prof })), 0),
                evasion: grants.evasion,
                concentration: grants.concentrationAdvantage
            },
            check: { minDie: grants.checkMinDie, floor: grants.checkFloor.filter(a => ABILITIES.includes(a)) }
        },
        features, choices, grants, spellInfo
    };
    sheet.combat = buildCombatKit(char, SRD, sheet);
    return sheet;
}

// Attack numbers for one weapon, with magic bonuses and monk/finesse rules.
export function weaponProfile(weapon, sheet, SRD, classes) {
    const { mods, prof, grants } = sheet;
    const props = (weapon.properties || []).map(p => p.index);
    const ranged = weapon.weapon_range === 'Ranged';
    const monk = grants.monkWeapons && !ranged && isMonkWeapon(weapon);
    let ability = ranged ? 'dex' : 'str';
    if (props.includes('finesse') || monk) ability = mods.dex >= mods.str ? 'dex' : 'str';
    const mod = mods[ability] || 0;
    const named = grants.proficiencies.map(p => String(p).toLowerCase());
    // A homebrew weapon has its own index, so "rapiers" cannot point at it:
    // match the class's specific-weapon grants against its name ("Rapier +1").
    const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const specific = !weapon.custom ? [] : classes.flatMap(c => ((SRD.get('classes', c.class) || {}).proficiencies || [])
        .map(p => (SRD.get('proficiencies', p.index) || {}).reference).filter(ref => ref && ref.index));
    const proficient = SRD.weaponProficient(classes, weapon)
        || specific.some(ref => flat(weapon.name).includes(flat(ref.name || ref.index)))
        || named.includes(String(weapon.name).toLowerCase()) || named.includes(weapon.index)
        || named.includes(`${String(weapon.weapon_category).toLowerCase()} weapons`);
    const bonus = weapon.bonus || 0;
    let dice = weapon.damage ? weapon.damage.damage_dice : '1';
    if (monk && grants.unarmedDamage && dieAverage(grants.unarmedDamage) > dieAverage(dice)) dice = grants.unarmedDamage;
    const total = mod + bonus;
    const tags = [ranged ? 'ranged' : 'melee'];
    if (props.includes('finesse')) tags.push('finesse');
    if (props.includes('thrown')) tags.push('thrown');
    return {
        name: weapon.name, attack: mod + (proficient ? prof : 0) + bonus,
        damage: dice + (total > 0 ? '+' + total : total < 0 ? String(total) : ''),
        damageType: ((weapon.damage && weapon.damage.damage_type && weapon.damage.damage_type.name) || '').toLowerCase(),
        ranged, rangeFt: (weapon.range && weapon.range.normal) || 5, tags
    };
}

function buildCombatKit(char, SRD, sheet) {
    const { mods, prof, total, grants, features } = sheet;
    const classes = char.classes || [];
    const eq = char.equipment || {};
    const attacks = (eq.weapons || []).map(idx => {
        const weapon = SRD.get('equipment', idx);
        return weapon ? weaponProfile(weapon, sheet, SRD, classes) : null;
    }).filter(Boolean);

    const unarmedMod = grants.unarmedFinesse ? Math.max(mods.str, mods.dex) : mods.str;
    attacks.push({
        name: 'Unarmed Strike', attack: unarmedMod + prof,
        damage: grants.unarmedDamage
            ? grants.unarmedDamage + (unarmedMod > 0 ? '+' + unarmedMod : unarmedMod < 0 ? String(unarmedMod) : '')
            : String(Math.max(1, 1 + unarmedMod)),
        damageType: 'bludgeoning', ranged: false, rangeFt: 5, tags: ['melee', 'unarmed']
    });

    const abilities = [], riders = [], resources = {};
    const addResource = (key, name, max, recharge) => {
        if (!key || resources[key]) return;
        const value = Math.max(0, Math.min(999, max));
        resources[key] = { name: String(name).slice(0, 40), max: value, current: value, recharge: recharge || 'short' };
    };
    let useCounter = 0;
    for (const feature of features) {
        const level = feature.classIdx ? feature.scaleLevel : total;
        const ctx = { ...mods, level: total, classLevel: feature.scaleLevel, prof };
        if (feature.resource) addResource(feature.resource.key, feature.resource.name, evalFormula(feature.resource.max, ctx), feature.resource.recharge);
        if (feature.rider) {
            riders.push({
                name: feature.name,
                damage: resolveDice(scaledDamage(feature.rider.damage, feature.rider.scaling, level), ctx),
                damageType: feature.rider.damageType || '',
                applies: feature.rider.applies || 'any',
                oncePerTurn: feature.rider.oncePerTurn !== false,
                requiresEffect: feature.rider.requiresEffect || '',
                auto: !!feature.rider.auto
            });
        }
        for (const action of feature.actions) {
            const name = action.name || feature.name;
            const damage = resolveDice(scaledDamage(action.damage, action.scaling, level), ctx);
            if (action.type === 'attack' && action.cost === 'attack') {
                // A natural weapon: it lives beside the weapon attacks.
                const ability = action.ability === 'best' ? (mods.dex >= mods.str ? 'dex' : 'str') : (action.ability || 'str');
                const mod = mods[ability] || 0;
                const dice = scaledDamage(action.damage, action.scaling, level) || '1';
                attacks.push({
                    name, attack: mod + (action.proficient === false ? 0 : prof),
                    damage: /d/i.test(dice) ? resolveDice(`${dice}+${mod}`, ctx) : String(Math.max(1, evalFormula(dice, ctx) + mod)),
                    damageType: action.damageType || '', ranged: !!action.ranged,
                    rangeFt: action.rangeFt || 5, tags: [action.ranged ? 'ranged' : 'melee', 'natural']
                });
                continue;
            }
            const ability = {
                name, type: action.type, cost: action.cost || 'action',
                damage, damageType: action.damageType || '',
                rangeFt: action.rangeFt || 5, area: action.area || 'single', areaFt: action.areaFt || 0,
                maxTargets: action.area === 'self' ? 0 : (action.maxTargets || 1)
            };
            if (action.type === 'attack') {
                const key = action.ability === 'best' ? (mods.dex >= mods.str ? 'dex' : 'str') : (action.ability || 'str');
                ability.attack = (mods[key] || 0) + (action.proficient === false ? 0 : prof);
            }
            if (action.type === 'save' || action.dc != null || action.dcAbility) {
                ability.saveAbility = action.saveAbility || 'dex';
                ability.saveSuccess = action.saveSuccess === 'none' ? 'none' : 'half';
                ability.dc = action.dc != null ? action.dc : 8 + prof + (mods[action.dcAbility] || 0);
            }
            if (action.resource) { ability.resource = action.resource; ability.resourceCost = action.resourceCost || 1; }
            if (action.uses) {
                const key = `use-${++useCounter}`;
                addResource(key, name, Math.max(1, evalFormula(action.uses, ctx)), action.recharge);
                ability.resource = key; ability.resourceCost = 1;
            }
            if (action.effect) ability.effect = action.effect;
            if (action.selfEffect) ability.selfEffect = action.selfEffect;
            if (action.grant) {
                ability.grant = action.grant;
                if (action.grant === 'attacks') { ability.grantCount = action.grantCount || 1; ability.grantAttack = action.grantAttack || ''; }
            }
            abilities.push(ability);
        }
    }
    return {
        attacks: attacks.slice(0, 12), abilities: abilities.slice(0, 24), riders: riders.slice(0, 8),
        resources, attacksPerAction: grants.attacksPerAction, critRange: grants.critRange
    };
}
