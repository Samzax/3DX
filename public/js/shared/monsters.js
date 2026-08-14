// monsters.js — dependency-free helpers for SRD/custom monster records.
//
// Map objects remain ordinary `token` objects. A compact monsterData snapshot
// gives both tabletop screens enough information for inspection while the
// server derives the encounter fields it owns from the same canonical values.

export const MONSTER_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const ABILITY_FIELDS = {
    str: 'strength', dex: 'dexterity', con: 'constitution',
    int: 'intelligence', wis: 'wisdom', cha: 'charisma'
};

const TYPE_COLORS = {
    aberration: '#8b5cf6', beast: '#65a30d', celestial: '#eab308',
    construct: '#64748b', dragon: '#dc2626', elemental: '#0891b2',
    fey: '#db2777', fiend: '#7f1d1d', giant: '#b45309',
    humanoid: '#2563eb', monstrosity: '#9333ea', ooze: '#16a34a',
    plant: '#15803d', undead: '#475569'
};

const CR_LABELS = new Map([[0.125, '1/8'], [0.25, '1/4'], [0.5, '1/2']]);

const numberIn = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const text = (value, max = 2000) => String(value == null ? '' : value).trim().slice(0, max);

export function monsterChallengeLabel(value) {
    const challenge = Number(value);
    if (!Number.isFinite(challenge)) return '—';
    return CR_LABELS.get(challenge) || String(challenge);
}

export function monsterAbilityMod(monster, ability) {
    const score = numberIn(monster?.[ABILITY_FIELDS[ability]], 1, 30, 10);
    return Math.floor((score - 10) / 2);
}

export function monsterAC(monster) {
    const raw = monster?.armor_class;
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            const value = numberIn(entry && typeof entry === 'object' ? entry.value : entry, 1, 30, null);
            if (value != null) return Math.round(value);
        }
    }
    return Math.round(numberIn(raw, 1, 30, 10));
}

function feet(value) {
    if (typeof value === 'number') return Math.max(0, Math.min(120, Math.round(value)));
    const matches = [...String(value || '').matchAll(/(-?\d+(?:\.\d+)?)\s*ft\.?/ig)];
    if (!matches.length) return null;
    const speeds = matches.map(match => Math.max(0, Math.min(120, Math.round(Number(match[1])))));
    return speeds.find(speed => speed > 0) ?? 0;
}

export function monsterSpeedFeet(monster) {
    const speed = monster?.speed;
    if (speed && typeof speed === 'object') {
        let stationary = null;
        const walk = feet(speed.walk);
        if (walk > 0) return walk;
        if (walk === 0) stationary = 0;
        for (const value of Object.values(speed)) {
            const parsed = feet(value);
            if (parsed > 0) return parsed;
            if (parsed === 0) stationary = 0;
        }
        if (stationary != null) return stationary;
    }
    return feet(speed) ?? 30;
}

export function monsterSavingThrows(monster) {
    const saves = {};
    for (const ability of MONSTER_ABILITIES) saves[ability] = monsterAbilityMod(monster, ability);
    for (const entry of monster?.proficiencies || []) {
        const index = String(entry?.proficiency?.index || entry?.index || '');
        const match = /^saving-throw-(str|dex|con|int|wis|cha)$/.exec(index);
        const value = Number(entry?.value);
        if (match && Number.isFinite(value)) saves[match[1]] = Math.max(-20, Math.min(30, Math.round(value)));
    }
    return saves;
}

function actionRange(action, ranged) {
    const explicit = numberIn(action?.range_ft, 5, 600, null);
    if (explicit != null) return Math.round(explicit);
    const description = String(action?.desc || '');
    const pattern = ranged ? /range\s+(\d+)(?:\s*\/\s*\d+)?\s*ft\.?/i : /reach\s+(\d+)\s*ft\.?/i;
    const match = pattern.exec(description);
    return match ? Math.max(5, Math.min(600, Number(match[1]))) : (ranged ? 30 : 5);
}

function actionDamageEntries(action) {
    // Top-level entries are simultaneous damage components. An options_array
    // represents alternatives (one-/two-handed, form choice), so use its first
    // listed/default option rather than incorrectly adding every choice.
    const raw = Array.isArray(action?.damage) ? action.damage : [];
    const entries = [];
    for (const damage of raw) {
        if (damage?.damage_dice) {
            entries.push(damage);
            continue;
        }
        const choice = (damage?.from?.options || [])
            .map(option => option?.item || option)
            .find(option => option?.damage_dice);
        if (choice) entries.push(choice);
    }
    if (!entries.length) {
        const match = /Hit:[\s\S]*?\((\d+\s*d\s*\d+(?:\s*[+-]\s*\d+)?)\)\s+([a-z]+)\s+damage/i.exec(String(action?.desc || ''));
        if (match) {
            const name = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
            entries.push({
                damage_dice: match[1],
                damage_type: { index: match[2].toLowerCase(), name }
            });
        }
    }
    return entries;
}

export function monsterAttacks(monster) {
    const attacks = [];
    for (const action of monster?.actions || []) {
        if (!action || !Number.isFinite(Number(action.attack_bonus))) continue;
        const damageEntries = actionDamageEntries(action).filter(entry => {
            const dice = String(entry?.damage_dice || '').replace(/\s+/g, '');
            return /^\d+d\d+(?:[+-]\d+)?$/i.test(dice) || /^\d+$/.test(dice);
        });
        const damage = damageEntries[0];
        if (!damage) continue;
        const description = String(action.desc || '');
        const ranged = action.attack_type === 'ranged' || /Ranged (?:Weapon|Spell) Attack/i.test(description);
        const attack = {
            name: text(action.name || 'Attack', 30) || 'Attack',
            attack: Math.max(-10, Math.min(30, Math.round(Number(action.attack_bonus)))),
            damage: text(damage.damage_dice, 20).replace(/\s+/g, ''),
            damageType: text(damage.damage_type?.index || damage.damage_type?.name, 20).toLowerCase(),
            ranged,
            rangeFt: actionRange(action, ranged)
        };
        if (damageEntries.length > 1) {
            attack.damageParts = damageEntries.slice(0, 4).map(entry => ({
                damage: text(entry.damage_dice, 20).replace(/\s+/g, ''),
                damageType: text(entry.damage_type?.index || entry.damage_type?.name, 20).toLowerCase()
            }));
        }
        attacks.push(attack);
        if (attacks.length >= 8) break;
    }
    return attacks;
}

export function monsterCombatStats(monster) {
    if (!monster || typeof monster !== 'object') return null;
    const maxHP = Math.round(numberIn(monster.hit_points, 1, 999, 1));
    return {
        ac: monsterAC(monster),
        speedFeet: monsterSpeedFeet(monster),
        initMod: monsterAbilityMod(monster, 'dex'),
        maxHP,
        saves: monsterSavingThrows(monster),
        attacks: monsterAttacks(monster)
    };
}

export function monsterColor(monster) {
    const own = String(monster?.color || '');
    if (/^#[0-9a-f]{6}$/i.test(own)) return own;
    return TYPE_COLORS[String(monster?.type || '').toLowerCase()] || '#b45309';
}

const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function signed(value) {
    const number = Number(value) || 0;
    return number >= 0 ? `+${number}` : String(number);
}

function monsterFeatureGroup(title, entries) {
    const features = (entries || []).filter(entry => entry && entry.name);
    if (!features.length) return '';
    return `<div class="monster-stat-group"><h4>${escapeHTML(title)}</h4>${features.map(entry => {
        const damage = actionDamageEntries(entry).map(item => `${item.damage_dice || ''} ${item.damage_type?.name || item.damage_type?.index || ''}`.trim()).join(' + ');
        const roll = entry.attack_bonus != null ? `${signed(entry.attack_bonus)} to hit` : '';
        const suffix = [roll, damage].filter(Boolean).join(' · ');
        return `<details><summary>${escapeHTML(entry.name)}${suffix ? ` <span>${escapeHTML(suffix)}</span>` : ''}</summary><p>${escapeHTML(entry.desc || 'No description.')}</p></details>`;
    }).join('')}</div>`;
}

// Safe, compact stat-block markup shared by GM and player inspectors. All SRD
// and homebrew strings are escaped here before they enter innerHTML.
export function monsterStatBlockHTML(monster) {
    if (!monster || typeof monster !== 'object') return '';
    const stats = monsterCombatStats(monster);
    const saves = monsterSavingThrows(monster);
    const abilities = MONSTER_ABILITIES.map(ability => {
        const score = Number(monster[ABILITY_FIELDS[ability]]) || 10;
        return `<div><span>${ability.toUpperCase()}</span><strong>${score}</strong><small>${signed(monsterAbilityMod(monster, ability))}</small></div>`;
    }).join('');
    const senses = Object.entries(monster.senses || {}).map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`).join(', ');
    const savesText = MONSTER_ABILITIES.map(ability => `${ability.toUpperCase()} ${signed(saves[ability])}`).join(', ');
    const defenses = [
        ['Vulnerable', monster.damage_vulnerabilities],
        ['Resistant', monster.damage_resistances],
        ['Immune', monster.damage_immunities],
        ['Condition immune', (monster.condition_immunities || []).map(item => item?.name || item?.index || item)]
    ].filter(([, values]) => Array.isArray(values) && values.length);
    return `<div class="selection-section monster-stat-block">
        <div class="selection-section-title"><span>Stat block</span><span>CR ${escapeHTML(monsterChallengeLabel(monster.challenge_rating))}</span></div>
        <div class="selection-metrics">
            <div class="selection-metric"><span>AC</span><strong>${escapeHTML(stats?.ac ?? '—')}</strong></div>
            <div class="selection-metric"><span>HP</span><strong>${escapeHTML(stats?.maxHP ?? '—')}</strong></div>
            <div class="selection-metric"><span>Speed</span><strong>${escapeHTML(stats?.speedFeet != null ? `${stats.speedFeet} ft` : '—')}</strong></div>
            <div class="selection-metric"><span>Hit dice</span><strong>${escapeHTML(monster.hit_dice || '—')}</strong></div>
        </div>
        <div class="monster-abilities">${abilities}</div>
        <dl class="monster-stat-lines">
            <div><dt>Saves</dt><dd>${escapeHTML(savesText)}</dd></div>
            ${senses ? `<div><dt>Senses</dt><dd>${escapeHTML(senses)}</dd></div>` : ''}
            ${monster.languages ? `<div><dt>Languages</dt><dd>${escapeHTML(monster.languages)}</dd></div>` : ''}
            ${defenses.map(([label, values]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(values.map(value => value?.name || value?.index || value).join(', '))}</dd></div>`).join('')}
        </dl>
        ${monsterFeatureGroup('Traits', monster.special_abilities)}
        ${monsterFeatureGroup('Actions', monster.actions)}
        ${monsterFeatureGroup('Reactions', monster.reactions)}
        ${monsterFeatureGroup('Legendary actions', monster.legendary_actions)}
        <div class="monster-license"><a href="/data/srd/ATTRIBUTION.md" target="_blank" rel="noopener">SRD 5.1 license &amp; attribution</a></div>
    </div>`;
}

function compactDamage(entry) {
    const dice = text(entry?.damage_dice, 30);
    if (!dice) return null;
    const index = text(entry?.damage_type?.index || entry?.damage_type?.name, 40).toLowerCase().replace(/\s+/g, '-');
    return {
        damage_dice: dice,
        damage_type: { index: index || 'untyped', name: text(entry?.damage_type?.name || index || 'Untyped', 60) }
    };
}

function compactAction(action) {
    if (!action || typeof action !== 'object') return null;
    const name = text(action.name, 120);
    if (!name) return null;
    const result = { name, desc: text(action.desc, 4000) };
    if (Number.isFinite(Number(action.attack_bonus))) result.attack_bonus = Math.round(numberIn(action.attack_bonus, -10, 30, 0));
    if (action.attack_type === 'melee' || action.attack_type === 'ranged') result.attack_type = action.attack_type;
    const range = numberIn(action.range_ft, 5, 600, null);
    if (range != null) result.range_ft = Math.round(range);
    const damage = actionDamageEntries(action).slice(0, 4).map(compactDamage).filter(Boolean);
    if (damage.length) result.damage = damage;
    if (action.dc && typeof action.dc === 'object') {
        const ability = text(action.dc.dc_type?.index, 8).toLowerCase();
        const value = numberIn(action.dc.dc_value, 1, 40, null);
        if (MONSTER_ABILITIES.includes(ability) && value != null) {
            result.dc = { dc_type: { index: ability, name: ability.toUpperCase() }, dc_value: Math.round(value), success_type: action.dc.success_type === 'half' ? 'half' : 'none' };
        }
    }
    return result;
}

// Strip API URLs, artwork references, and unused nested fields before a monster
// becomes a persistent map snapshot. The licensed rules text needed for the
// in-app stat block remains intact.
export function monsterTokenSnapshot(monster) {
    if (!monster || typeof monster !== 'object') return null;
    const name = text(monster.name, 80);
    if (!name) return null;
    const snapshot = {
        index: text(monster.index, 96),
        name,
        source: monster.custom ? 'homebrew' : 'srd-5.1',
        size: text(monster.size, 20) || 'Medium',
        type: text(monster.type, 40) || 'monstrosity',
        alignment: text(monster.alignment, 80),
        color: monsterColor(monster),
        armor_class: [{ type: text(monster.armor_class?.[0]?.type, 30) || 'natural', value: monsterAC(monster) }],
        hit_points: Math.round(numberIn(monster.hit_points, 1, 999, 1)),
        hit_dice: text(monster.hit_dice || monster.hit_points_roll, 30) || '1d8',
        speed: {},
        challenge_rating: numberIn(monster.challenge_rating, 0, 30, 0),
        xp: Math.round(numberIn(monster.xp, 0, 1_000_000, 0)),
        proficiency_bonus: Math.round(numberIn(monster.proficiency_bonus, 0, 12, 2)),
        languages: text(monster.languages, 500),
        proficiencies: [],
        damage_vulnerabilities: [],
        damage_resistances: [],
        damage_immunities: [],
        condition_immunities: [],
        senses: {},
        special_abilities: (monster.special_abilities || []).slice(0, 32).map(compactAction).filter(Boolean),
        actions: (monster.actions || []).slice(0, 32).map(compactAction).filter(Boolean),
        reactions: (monster.reactions || []).slice(0, 16).map(compactAction).filter(Boolean),
        legendary_actions: (monster.legendary_actions || []).slice(0, 16).map(compactAction).filter(Boolean)
    };
    for (const ability of MONSTER_ABILITIES) {
        snapshot[ABILITY_FIELDS[ability]] = Math.round(numberIn(monster[ABILITY_FIELDS[ability]], 1, 30, 10));
    }
    const rawSpeed = monster.speed && typeof monster.speed === 'object' ? monster.speed : { walk: monster.speed };
    for (const [kind, value] of Object.entries(rawSpeed || {}).slice(0, 8)) {
        const key = text(kind, 20).toLowerCase().replace(/[^a-z-]/g, '');
        const speedText = text(value, 40);
        if (key && speedText) snapshot.speed[key] = speedText;
    }
    if (!Object.keys(snapshot.speed).length) snapshot.speed.walk = `${monsterSpeedFeet(monster)} ft.`;
    snapshot.proficiencies = (monster.proficiencies || []).slice(0, 32).map(entry => {
        const index = text(entry?.proficiency?.index || entry?.index, 96);
        const value = numberIn(entry?.value, -20, 30, null);
        return index && value != null ? { value: Math.round(value), proficiency: { index, name: text(entry?.proficiency?.name || index, 120) } } : null;
    }).filter(Boolean);
    for (const key of ['damage_vulnerabilities', 'damage_resistances', 'damage_immunities']) {
        snapshot[key] = (monster[key] || []).slice(0, 32).map(value => text(value, 80)).filter(Boolean);
    }
    snapshot.condition_immunities = (monster.condition_immunities || []).slice(0, 32).map(value => ({
        index: text(value?.index || value, 80), name: text(value?.name || value, 120)
    })).filter(value => value.index || value.name);
    if (monster.senses && typeof monster.senses === 'object') {
        for (const [kind, value] of Object.entries(monster.senses).slice(0, 16)) {
            const key = text(kind, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
            if (!key) continue;
            snapshot.senses[key] = typeof value === 'number' ? value : text(value, 120);
        }
    }
    if (monster.custom) snapshot.custom = true;
    if (monster.owner) snapshot.owner = text(monster.owner, 40);
    return snapshot;
}
