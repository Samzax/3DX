// combat.js — shared combat-mode client pieces for the GM and player screens:
// the SRD→combatant stat derivation, the initiative tracker + combat log UI
// (CombatTracker), and the three.js overlays (turn ring, movement-range ring,
// effect badges). The server owns the combat state and all dice; this module
// only renders state and emits the combat-* events.

import * as THREE from 'three';
import { ABILITIES } from './srd.js';
import { buildSheet } from './rules.js';
import { spellDice } from './spellinfo.js';
import { AREA_KINDS, describeShape, normalizeShape, shapeNeedsPoint } from './aoe.js';
import {
    combatCssColor, combatInteger, combatModifier, combatNumber, combatSpellLevel
} from './combat-safety.js';

const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Effect keys mirror the server's CONDITION_LABELS. auto effects (Dash/Dodge/
// Disengage) expire at the start of the combatant's next turn.
export const EFFECTS = {
    dodging: { label: 'Dodge', glyph: '🛡️' },
    disengaged: { label: 'Disengage', glyph: '↪' },
    dashed: { label: 'Dash', glyph: '💨' },
    down: { label: 'Down', glyph: '💀' },
    prone: { label: 'Prone', glyph: '⬇' },
    poisoned: { label: 'Poisoned', glyph: '🤢' },
    restrained: { label: 'Restrained', glyph: '⛓' },
    stunned: { label: 'Stunned', glyph: '💫' },
    blinded: { label: 'Blinded', glyph: '🙈' },
    frightened: { label: 'Frightened', glyph: '😱' },
    grappled: { label: 'Grappled', glyph: '✊' },
    invisible: { label: 'Invisible', glyph: '👻' },
    raging: { label: 'Raging', glyph: '🔥' },
    hidden: { label: 'Hidden', glyph: '🥷' },
    blessed: { label: 'Blessed', glyph: '✨' },
    flying: { label: 'Flying', glyph: '🦅' }, // models with a 'fly' clip take to the air (monster-anim.js)
    paralyzed: { label: 'Paralyzed', glyph: '🧊' }
};

// SRD spells whose whole effect is a condition the tracker knows. With `save`
// every creature picked or caught rolls it (failure = the condition); without
// one the caster picks up to `targets` creatures and it simply lands.
// Concentration and duration come from the spell record itself.
const SPELL_EFFECTS = {
    'bless': { effect: 'blessed', targets: 3 },
    'invisibility': { effect: 'invisible' },
    'greater-invisibility': { effect: 'invisible' },
    'fly': { effect: 'flying' },
    'hold-person': { effect: 'paralyzed', save: 'wis' },
    'hold-monster': { effect: 'paralyzed', save: 'wis' },
    'entangle': { effect: 'restrained', save: 'str' },
    'web': { effect: 'restrained', save: 'dex' },
    'fear': { effect: 'frightened', save: 'wis' },
    'blindness-deafness': { effect: 'blinded', save: 'con' },
    'stinking-cloud': { effect: 'poisoned', save: 'con' }
};

// How a spell with no area looks on the map (shared/spellfx.js): named ones
// first, then by what the spell is — a heal, a touch, a beam, a thrown bolt, a
// column from above for saves against light and storm, a ring for the rest.
const SPELL_FORMS = {
    'sacred-flame': 'strike', 'call-lightning': 'strike', 'flame-strike': 'strike', 'moonbeam': 'strike',
    'eldritch-blast': 'ray', 'guiding-bolt': 'ray', 'disintegrate': 'ray', 'scorching-ray': 'ray',
    'chill-touch': 'bolt', 'magic-missile': 'bolt', 'spare-the-dying': 'heal'
};
const STRIKE_TYPES = new Set(['radiant', 'lightning', 'fire', 'thunder']);
export function spellForm(spell) {
    if (!spell) return '';
    if (SPELL_FORMS[spell.index]) return SPELL_FORMS[spell.index];
    if (spell.heal_at_slot_level) return 'heal';
    const type = ((spell.damage && spell.damage.damage_type && spell.damage.damage_type.name) || '').toLowerCase();
    if (spell.attack_type) return spell.attack_type === 'melee' ? 'touch' : /\bray\b|beam/i.test(spell.name || '') ? 'ray' : 'bolt';
    if (spell.damage) return STRIKE_TYPES.has(type) ? 'strike' : 'touch';
    return 'aura';
}
// Healing that reaches more than one creature.
const HEAL_TARGETS = { 'mass-cure-wounds': 6, 'mass-healing-word': 6, 'prayer-of-healing': 6, 'mass-heal': 12 };

// SRD spells whose area stays on the map: a creature saves when it starts its
// turn there and/or walks in (`on`), not when the spell is cast — unless
// `initial`. `follow`: the area is an aura round its caster. Damage, save and
// size come from the spell record.
const SPELL_ZONES = {
    'moonbeam': { on: 'both' },
    'spirit-guardians': { on: 'both', follow: true },
    'cloudkill': { on: 'both' },
    'insect-plague': { on: 'both', initial: true },
    'flaming-sphere': { on: 'start' },
    'web': { on: 'both', initial: true },
    'stinking-cloud': { on: 'start' }
};
// Spells that are a light (or a darkness) on a creature, in feet (vision.js).
const SPELL_LIGHTS = {
    'light': { bright: 20, dim: 20, dark: 0 },
    'daylight': { bright: 60, dim: 60, dark: 0 },
    'darkness': { bright: 0, dim: 0, dark: 15 }
};
export function spellLight(spell) { return (spell && SPELL_LIGHTS[spell.index]) || null; }
// Spells that leave something on the map for the caster to move (summons.js):
// how far from the caster it may be, how far it goes in a turn, whether it
// attacks with the spell's damage (`strike`), the light it sheds.
const SPELL_SUMMONS = {
    'mage-hand': { kind: 'hand', leashFt: 30, moveFt: 30 },
    'spiritual-weapon': { kind: 'weapon', leashFt: 0, moveFt: 20, strike: true },
    'dancing-lights': { kind: 'lights', leashFt: 120, moveFt: 60, light: { bright: 0, dim: 10, dark: 0 } },
    'unseen-servant': { kind: 'servant', leashFt: 60, moveFt: 15 },
    'floating-disk': { kind: 'disk', leashFt: 100, moveFt: 30 }
};
export function spellSummon(spell) { return (spell && SPELL_SUMMONS[spell.index]) || null; }

// "Up to 1 minute" → 10 rounds (0 = no clock the tracker should run).
export function spellRounds(spell) {
    const found = /(\d+)\s*(round|minute|hour)/i.exec(String((spell && spell.duration) || ''));
    if (!found) return 0;
    return Math.min(14400, Number(found[1]) * { round: 1, minute: 10, hour: 600 }[found[2].toLowerCase()]);
}
// Conditions the GM can hand out from the tracker (the auto ones come from actions).
const GM_CONDITIONS = ['prone', 'poisoned', 'restrained', 'stunned', 'paralyzed', 'blinded', 'frightened', 'grappled', 'invisible', 'raging', 'hidden', 'blessed', 'flying', 'down'];

export function remainingFeet(c) {
    const speed = combatNumber(c?.speedFeet, { fallback: 0, min: 0, max: 1000000 });
    const dash = combatNumber(c?.dashFeet, { fallback: 0, min: 0, max: 1000000 });
    const used = combatNumber(c?.movementUsedFeet, { fallback: 0, min: 0, max: 2000000 });
    return Math.max(0, Math.round(speed + dash - used));
}

// Combat stats for a character: the shared sheet (rules.js buildSheet — the
// same derivation the creator and the player HUD show) trimmed to what the
// server's combatant entry needs, plus the feature combat kit.
export function deriveCombatStats(char, SRD) {
    const sheet = buildSheet(char, SRD);
    const { mods, prof } = sheet;
    const classes = char.classes || [];
    const kit = sheet.combat;
    const saves = {};
    for (const a of ABILITIES) saves[a] = mods[a] + (sheet.saves.has(a) ? prof : 0);

    const casterClass = classes.find(c => SRD.isCaster(c.class));
    let spellAtk = 0, spellDC = 8, spells = [];
    let slots = { 1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0 };
    let pact = null;
    if (casterClass) {
        const abil = SRD.spellcastingAbility(casterClass.class);
        const cmod = (abil && mods[abil]) || 0;
        spellAtk = prof + cmod;
        spellDC  = 8 + prof + cmod;
        const slotInfo = SRD.spellSlots(classes);
        slots = slotInfo.slots;
        pact = slotInfo.pact || null; // warlock: { level, count }, cast through the same tracker
        const totLvl = SRD.totalLevel(classes);
        const maxSlot = Math.max(pact ? pact.level : 0,
            Object.keys(slots).reduce((m, l) => slots[l] > 0 ? Math.max(m, +l) : m, 0));
        for (const idx of (char.spells || [])) {
            const sp = SRD.get('spells', idx);
            const held = SPELL_EFFECTS[idx];
            const lit = SPELL_LIGHTS[idx];
            const summon = SPELL_SUMMONS[idx];
            if (!sp || (!sp.damage && !held && !lit && !summon && !sp.heal_at_slot_level)) continue;
            const lvl = sp.level || 0;
            if (lvl > 0 && lvl > maxSlot) continue;
            const hold = {
                ...(sp.concentration ? { concentration: true, ...(spellRounds(sp) ? { rounds: spellRounds(sp) } : {}) } : {}),
                form: spellForm(sp),
                ...(/bonus/i.test(sp.casting_time || '') ? { time: 'bonus' } : {}),
                ...(SPELL_ZONES[idx] ? { zone: SPELL_ZONES[idx] } : {})
            };
            if (lit) {
                spells.push({ name: sp.name, level: lvl, damage: '', light: lit, maxTargets: 1, ...hold, form: 'aura' });
                continue;
            }
            if (summon) {
                // Set down at a point; a weapon strikes with the spell's dice.
                const dice = summon.strike ? ((spellDice(sp, { slotLevel: lvl, abilityMod: cmod }) || {}).expr || '1d8').replace(/\s+/g, '') : '';
                const { zone, ...kept } = hold;
                spells.push({
                    name: sp.name, level: lvl, damage: dice,
                    damageType: summon.strike ? (((sp.damage || {}).damage_type || {}).name || 'force').toLowerCase() : '',
                    summon, rangeFt: spellArea(sp).rangeFt || 5, ...kept,
                    ...(!sp.concentration && spellRounds(sp) ? { rounds: spellRounds(sp) } : {}), form: 'aura'
                });
                continue;
            }
            if (!sp.damage && !held) {
                // Healing: the dice at each slot, the casting modifier folded in.
                const healAt = (slot) => ((spellDice(sp, { slotLevel: slot, abilityMod: cmod }) || {}).expr || '').replace(/\s+/g, '');
                const heal = healAt(lvl);
                if (!heal || /minute|hour/i.test(sp.casting_time || '')) continue; // Prayer of Healing takes ten minutes
                const bySlot = {};
                for (let slot = lvl + 1; slot <= maxSlot; slot++) { const expr = healAt(slot); if (expr && expr !== heal) bySlot[slot] = expr; }
                spells.push({
                    name: sp.name, level: lvl, damage: '', heal, maxTargets: HEAL_TARGETS[idx] || 1,
                    ...(Object.keys(bySlot).length ? { bySlot } : {}), rangeFt: spellArea(sp).rangeFt, ...hold
                });
                continue;
            }
            if (!sp.damage) {
                spells.push({
                    name: sp.name, level: lvl, damage: '', effect: held.effect,
                    ...(held.save ? { saveAbility: held.save, saveSuccess: 'none' } : { maxTargets: held.targets || 1 }),
                    ...spellArea(sp), ...hold
                });
                continue;
            }
            let dice = null;
            if (lvl === 0) {
                const tbl = sp.damage.damage_at_character_level || {};
                const ks = Object.keys(tbl).map(Number).sort((a, b) => a - b);
                const pick = ks.filter(k => k <= totLvl).pop() ?? ks[0];
                dice = pick != null ? tbl[pick] : null;
            } else {
                dice = (sp.damage.damage_at_slot_level || {})[String(lvl)] || null;
            }
            if (!dice) continue;
            const damageType = ((sp.damage.damage_type && sp.damage.damage_type.name) || '').toLowerCase();
            // Upcasting: the dice at every higher slot the caster could use.
            const bySlot = {};
            if (lvl > 0) {
                for (const [slot, expr] of Object.entries(sp.damage.damage_at_slot_level || {})) {
                    if (+slot > lvl && +slot <= maxSlot && typeof expr === 'string') bySlot[slot] = expr.replace(/\s+/g, '');
                }
            }
            const extra = { ...(Object.keys(bySlot).length ? { bySlot } : {}), ...spellArea(sp), ...hold };
            if (sp.attack_type) {
                spells.push({ name: sp.name, level: lvl, attackType: sp.attack_type === 'melee' ? 'melee' : 'ranged', damage: dice, damageType, ...extra });
            } else if (sp.dc && (sp.dc.dc_success === 'half' || sp.dc.dc_success === 'none')) {
                const saveAbility = (sp.dc.dc_type && sp.dc.dc_type.index) || 'dex';
                spells.push({ name: sp.name, level: lvl, saveAbility, saveSuccess: sp.dc.dc_success, damage: dice, damageType, ...extra });
            }
        }
        spells = spells.slice(0, 20).map((s, i) => ({ ...s, spellIndex: i }));
    }
    return {
        ac: sheet.ac, speedFeet: sheet.speed, initMod: sheet.init,
        maxHP: sheet.maxHP, attacks: kit.attacks, saves, spellAtk, spellDC, slots, spells,
        ...(pact ? { pact } : {}),
        abilities: kit.abilities, riders: kit.riders, resources: kit.resources,
        attacksPerAction: kit.attacksPerAction, critRange: kit.critRange,
        saveMods: sheet.rollMods.save
    };
}

// Where a spell reaches and what it covers, from the SRD record: "150 feet" +
// a 20 ft sphere is thrown; "Self (15-foot cone)" leaves the caster; a sphere
// around "Self" is an aura that spares the caster.
export function spellArea(spell) {
    const range = String(spell.range || '');
    const feet = /(\d+)\s*(?:feet|foot|ft)/i.exec(range);
    const self = /^self/i.test(range);
    const rangeFt = self ? 0 : /touch/i.test(range) ? 5 : feet ? Math.min(600, Number(feet[1])) : 0;
    const area = spell.area_of_effect;
    const type = area && String(area.type || '').toLowerCase();
    if (!AREA_KINDS.includes(type) || !(Number(area.size) > 0)) return { rangeFt };
    const round = type === 'sphere' || type === 'cylinder';
    return { rangeFt, area: self && round ? 'self' : type, areaFt: Math.min(300, Number(area.size)) };
}

// The shape a kit spell or ability is aimed with (shared/aoe.js), or null when
// it picks creatures instead. Mirrors the server's rule for who must aim.
export function aimShapeOf(item, mode) {
    // A summoned thing is set down at a point within the spell's range.
    if (item && item.summon && mode === 'cast') return normalizeShape({ kind: 'sphere', sizeFt: 3, rangeFt: item.rangeFt || 5 });
    if (!item || (mode === 'cast' ? !item.saveAbility : item.type !== 'save')) return null;
    const kind = item.area;
    const thrown = kind === 'sphere' || kind === 'cylinder' || (mode === 'cast' && kind === 'cube');
    const shape = normalizeShape({ kind, sizeFt: item.areaFt, rangeFt: thrown ? item.rangeFt : 0 });
    return shapeNeedsPoint(shape) || (shape.kind === 'self' && shape.sizeFt > 0) ? shape : null;
}

// One spell in the tracker's Cast menu.
function castButtonHTML(c, spell, i) {
    const spellLevel = combatSpellLevel(spell?.level);
    // Any slot it can burn: its own level, or a warlock's pact slot at or above it.
    const slots = combatInteger(c.slots?.[spellLevel], { fallback: 0, min: 0, max: 99 })
        + (c.pact && c.pact.level >= spellLevel ? combatInteger(c.pact.left, { fallback: 0, min: 0, max: 99 }) : 0);
    const quick = spell?.time === 'bonus';
    const disabled = (spellLevel > 0 && slots < 1) || (quick ? c.bonusUsed : c.actionUsed) ? ' disabled' : '';
    const level = spellLevel === 0 ? 'Cantrip' : `L${spellLevel}`;
    const reach = describeShape({ kind: spell?.area, sizeFt: spell?.areaFt });
    const does = spell?.summon ? (spell.summon.strike ? `summons · ${escHtml(spell.damage)} ${escHtml(spell?.damageType)}` : 'summons')
        : spell?.damage ? `${escHtml(spell.damage)} ${escHtml(spell?.damageType)}`
        : spell?.heal ? `heals ${escHtml(spell.heal)}`
        : spell?.light ? (spell.light.dark ? 'darkness' : 'light')
        : escHtml((EFFECTS[spell?.effect] || {}).label || 'effect');
    return `<button class="btn-combat" data-act="cast" data-id="${escHtml(c.id)}" data-spell="${i}"${disabled}>${escHtml(spell?.name)} — ${level} · ${does}${reach ? ` · ${escHtml(reach)}` : ''}${spell?.zone ? ' · stays' : ''}${quick ? ' · bonus' : ''}${spell?.concentration ? ' · conc.' : ''}</button>`;
}

export function combatAttackDamageLabel(attack) {
    const parts = Array.isArray(attack?.damageParts) && attack.damageParts.length > 1
        ? attack.damageParts
        : [{ damage: attack?.damage, damageType: attack?.damageType }];
    return parts.map(part => [part?.damage, part?.damageType].filter(Boolean).join(' ')).filter(Boolean).join(' + ');
}

const LOG_ICONS = { info: '•', initiative: '🎲', attack: '⚔', cast: '✨', action: '✦', turn: '▶', damage: '💥' };

// --- Action economy helpers (shared by the tracker and the player panel) -----
// Can this attack be made right now? The Attack action, an Extra Attack left
// over from it, or a strike a bonus action granted (possibly one named attack).
export function attackAvailable(c, attack) {
    if (!c) return false;
    if (!c.actionUsed || c.attacksLeft > 0) return true;
    const granted = c.bonusAttacks;
    if (!granted || !(granted.count > 0)) return false;
    return !granted.only || String(attack?.name || '').toLowerCase().includes(String(granted.only).toLowerCase());
}

export function abilityUsable(c, ability) {
    if (!c || !ability) return false;
    if (ability.cost === 'action' && c.actionUsed) return false;
    if (ability.cost === 'bonus' && c.bonusUsed) return false;
    if (ability.rechargeOn && ability.spent) return false;
    if (ability.resource) {
        const resource = c.resources && c.resources[ability.resource];
        if (!resource || resource.current < (ability.resourceCost || 1)) return false;
    }
    return true;
}

// "bonus · 3d6 cold · DC 13 CON half · 15 ft cone · Ki 1"
export function combatAbilityLabel(ability, c) {
    const parts = [ability.cost === 'bonus' ? 'bonus' : ability.cost === 'free' ? 'free' : 'action'];
    if (ability.type === 'heal') parts.push(`heal ${ability.damage}`);
    else if (ability.damage) parts.push([ability.damage, ability.damageType].filter(Boolean).join(' '));
    if (ability.type === 'attack') parts.push(`${combatModifier(ability.attack)} to hit`);
    if (ability.type === 'save') parts.push(`DC ${combatInteger(ability.dc, { fallback: 10, min: 1, max: 40 })} ${String(ability.saveAbility || '').toUpperCase()}${ability.damage ? (ability.saveSuccess === 'half' ? ' half' : '') : ''}`);
    if (ability.area && ability.area !== 'single' && ability.area !== 'self') parts.push(`${ability.areaFt ? ability.areaFt + ' ft ' : ''}${ability.area}`);
    if (ability.effect && EFFECTS[ability.effect]) parts.push(EFFECTS[ability.effect].label);
    if (ability.resource && c && c.resources && c.resources[ability.resource] && !/^use-/.test(ability.resource)) {
        parts.push(`${c.resources[ability.resource].name} ${ability.resourceCost || 1}`);
    }
    if (ability.rechargeOn) parts.push(ability.spent ? 'recharging' : `recharge ${ability.rechargeOn}+`);
    return parts.join(' · ');
}

// What the attacker toggled before swinging: optional riders (Sneak Attack)
// and advantage. Kept per combatant, client-side only; the server re-checks.
const attackOptionState = new Map();
function optionsFor(id) {
    if (!attackOptionState.has(id)) attackOptionState.set(id, { riders: new Set(), advantage: false });
    return attackOptionState.get(id);
}
export function attackPayloadOptions(c) {
    if (!c) return {};
    const state = optionsFor(c.id);
    const riders = [...state.riders].filter(i => c.riders && c.riders[i] && !c.riders[i].auto);
    return { ...(riders.length ? { riders } : {}), ...(state.advantage ? { advantage: true } : {}) };
}
// Toggle from a [data-opt] control. Returns true when the click was one.
export function toggleAttackOption(el) {
    const control = el && el.closest && el.closest('[data-opt]');
    if (!control) return false;
    const state = optionsFor(control.dataset.id);
    if (control.dataset.opt === 'advantage') state.advantage = !state.advantage;
    else {
        const index = Number(control.dataset.rider);
        if (state.riders.has(index)) state.riders.delete(index); else state.riders.add(index);
    }
    return true;
}

// Resource pips, rider toggles and the advantage switch for one combatant.
export function combatOptionsHTML(c) {
    const state = optionsFor(c.id);
    const resources = Object.entries(c.resources || {}).map(([key, r]) =>
        `<span class="tag combat-resource" title="${escHtml(r.recharge)} rest">${escHtml(r.name)} ${combatInteger(r.current, { fallback: 0, min: 0, max: 999 })}/${combatInteger(r.max, { fallback: 0, min: 0, max: 999 })}</span>`).join('');
    const riders = (Array.isArray(c.riders) ? c.riders : []).map((rider, i) => {
        const label = `${escHtml(rider.name)} +${escHtml(rider.damage)}`;
        if (rider.auto) return `<span class="tag" title="Applies automatically">${label}</span>`;
        const used = Array.isArray(c.ridersUsed) && c.ridersUsed.includes(i);
        const on = state.riders.has(i);
        return `<button class="btn-combat toggle${on ? ' on' : ''}" data-opt="rider" data-id="${escHtml(c.id)}" data-rider="${i}" aria-pressed="${on}"${used ? ' disabled title="Already used this turn"' : ''}>${on ? '☑' : '☐'} ${label}</button>`;
    }).join('');
    const advantage = `<button class="btn-combat toggle${state.advantage ? ' on' : ''}" data-opt="advantage" data-id="${escHtml(c.id)}" aria-pressed="${state.advantage}">${state.advantage ? '☑' : '☐'} Advantage</button>`;
    return `${resources}${riders}${advantage}`;
}

export function combatAbilityButtonsHTML(c) {
    return (Array.isArray(c.abilities) ? c.abilities : []).map((ability, i) =>
        `<button class="btn-combat ability" data-act="ability" data-id="${escHtml(c.id)}" data-ability="${i}"${abilityUsable(c, ability) ? '' : ' disabled'}>✦ ${escHtml(ability.name)} <span class="tag">${escHtml(combatAbilityLabel(ability, c))}</span></button>`
    ).join('');
}

// Target picking for feature abilities. Self abilities fire at once; the rest
// collect up to maxTargets tokens (click toggles, Enter fires early, Esc
// cancels) so a cone or burst can catch several creatures in one use.
export class AbilityTargeting {
    constructor({ getSocket, flash, onChange }) {
        this.getSocket = getSocket;
        this.flash = flash || (() => {});
        this.onChange = onChange || (() => {});
        this.pending = null;
    }
    get active() { return !!this.pending; }
    // mode 'cast': a kit spell that lands on the creatures picked (Bless);
    // `extra` rides the action (the slot it is cast with).
    begin(combatantId, abilityIndex, ability, mode = 'ability', extra = {}) {
        const max = combatInteger(ability?.maxTargets, { fallback: 0, min: 0, max: 12 });
        if (max === 0) { this.emit(combatantId, abilityIndex, [], mode, extra); return; }
        this.pending = { combatantId, abilityIndex, name: ability.name, max, targets: [], mode, extra, optional: mode === 'cast' || ability.type === 'heal' || ability.type === 'utility' };
        this.flash(this.hint());
        this.onChange();
    }
    emit(combatantId, abilityIndex, targetIds, mode = 'ability', extra = {}) {
        const socket = this.getSocket();
        if (!socket) return;
        if (mode === 'cast') socket.emit('combat-action', { combatantId, kind: 'cast', spellIndex: abilityIndex, targetIds, ...extra });
        else if (mode === 'strike') socket.emit('combat-action', { combatantId, kind: 'strike', summonId: extra.summonId, targetId: targetIds[0] }); // a summoned weapon
        else socket.emit('combat-action', { combatantId, kind: 'ability', abilityIndex, targetIds, ...(optionsFor(combatantId).advantage ? { advantage: true } : {}) });
    }
    // targetId is null when the click missed every combatant.
    click(targetId) {
        const p = this.pending;
        if (!p) return;
        if (!targetId) { this.flash(`${p.name}: that is not a combatant — Esc cancels`); return; }
        const at = p.targets.indexOf(targetId);
        if (at >= 0) p.targets.splice(at, 1); else p.targets.push(targetId);
        if (p.targets.length >= p.max) { this.confirm(); return; }
        this.flash(this.hint());
        this.onChange();
    }
    confirm() {
        const p = this.pending;
        if (!p) return false;
        if (!p.targets.length && !p.optional) { this.flash(`${p.name}: pick at least one target`); return true; }
        this.pending = null;
        this.emit(p.combatantId, p.abilityIndex, p.targets, p.mode, p.extra);
        this.onChange();
        return true;
    }
    cancel(silent = false) {
        if (!this.pending) return false;
        const name = this.pending.name;
        this.pending = null;
        if (!silent) this.flash(`${name} cancelled`);
        this.onChange();
        return true;
    }
    hint() {
        const p = this.pending;
        if (!p) return '';
        return p.max === 1
            ? `${p.name}: click a target${p.optional ? ' (Enter = yourself)' : ''} · Esc cancels`
            : `${p.name}: ${p.targets.length}/${p.max} targets — click tokens · Enter fires · Esc cancels`;
    }
}

// --- Initiative tracker + combat log -----------------------------------------
// One instance per screen. setState(combat|null) re-renders everything;
// appendLog streams a line in between state broadcasts. All clicks are
// delegated through data-act attributes; the page supplies onPickTarget to run
// its 3D target-pick flow when an attack button is pressed.
export class CombatTracker {
    constructor({ container, socket, isGM, username, onPickTarget, onFocusCombatant, getMapObjects }) {
        this.container = container;
        this.socket = socket;
        this.isGM = !!isGM;
        this.username = username;
        this.onPickTarget = onPickTarget || (() => {});
        this.onFocusCombatant = onFocusCombatant || (() => {});
        this.getMapObjects = getMapObjects || (() => []);
        this.state = null;
        this.flashTimer = null;
        this.logOpen = false;
        container.classList.add('combat-tracker');
        container.addEventListener('click', (e) => this.onClick(e));
        container.addEventListener('change', (e) => this.onChange(e));
    }

    canControl(c) { return this.isGM || (!!c.owner && c.owner === this.username); }

    displayName(c) {
        const object = this.getMapObjects().find(candidate => candidate.id === c.id);
        return (object && object.name) || c.name;
    }

    setState(combat) {
        this.state = combat;
        if (!combat) { this.container.classList.add('hidden'); this.container.innerHTML = ''; return; }
        this.container.classList.remove('hidden');
        this.render();
        if (combat.activeId) {
            const activeId = String(combat.activeId);
            requestAnimationFrame(() => {
                const row = [...this.container.querySelectorAll('[data-row]')]
                    .find(candidate => candidate.dataset.row === activeId);
                const scroller = this.container.querySelector('.ct-rows');
                const center = () => {
                    if (!row || !scroller || String(this.state?.activeId) !== activeId) return;
                    scroller.scrollLeft = row.offsetLeft - (scroller.clientWidth - row.offsetWidth) / 2;
                };
                center();
                // The active card widens with a short CSS transition; center it
                // once more after that transition so its actions never clip.
                setTimeout(center, 220);
            });
        }
    }

    appendLog(entry) {
        if (!this.state) return;
        if (!Array.isArray(this.state.log)) this.state.log = [];
        if (this.state.log.some(l => l.id === entry.id)) return;
        this.state.log.push(entry);
        const logEl = this.container.querySelector('.combat-log');
        if (logEl) {
            logEl.insertAdjacentHTML('beforeend', this.logLineHTML(entry));
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    flash(text) {
        const el = this.container.querySelector('.combat-flash');
        if (!el) return;
        el.textContent = text;
        el.classList.add('show');
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => el.classList.remove('show'), 2500);
    }

    logLineHTML(entry) {
        entry = entry && typeof entry === 'object' ? entry : {};
        return `<div class="log-line log-${escHtml(entry.kind)}"><span class="log-ic">${LOG_ICONS[entry.kind] || '•'}</span>${escHtml(entry.text)}</div>`;
    }

    // The combatant ids in display order: turn order once started, name order while gathering.
    displayOrder() {
        const s = this.state;
        const combatants = s?.combatants && typeof s.combatants === 'object' && !Array.isArray(s.combatants)
            ? s.combatants : {};
        const order = Array.isArray(s?.order) ? s.order.map(String) : [];
        if (s?.started && order.length) {
            const extra = Object.keys(combatants).filter(id => !order.includes(id));
            return [...order.filter(id => combatants[id]), ...extra];
        }
        return Object.keys(combatants).sort((a, b) =>
            String(combatants[a]?.name).localeCompare(String(combatants[b]?.name)));
    }

    rowHTML(c, idx) {
        const s = this.state;
        c = c && typeof c === 'object' ? c : {};
        const displayName = this.displayName(c);
        const active = s.started && s.activeId === c.id;
        const mine = this.canControl(c);
        const maxHP = combatInteger(c.maxHP, { fallback: 1, min: 0, max: 1000000 });
        const hasCurrentHP = c.hp && (typeof c.hp.current === 'number' || typeof c.hp.current === 'string');
        const hpCurrent = combatInteger(c.hp?.current, { fallback: maxHP, min: 0, max: 1000000 });
        const hp = hasCurrentHP ? `${hpCurrent}/${maxHP}` : `—/${maxHP}`;
        const hpPct = Math.max(0, Math.min(100, Math.round((hpCurrent / Math.max(1, maxHP)) * 100)));
        const moveTotal = Math.max(0,
            combatNumber(c.speedFeet, { fallback: 0, min: 0, max: 1000000 })
            + combatNumber(c.dashFeet, { fallback: 0, min: 0, max: 1000000 }));
        const movePct = moveTotal > 0
            ? Math.max(0, Math.min(100, Math.round((remainingFeet(c) / moveTotal) * 100)))
            : 0;
        const badges = (Array.isArray(c.effects) ? c.effects : []).filter(e => e && typeof e === 'object').map(e => {
            const glyph = (EFFECTS[e.key] && EFFECTS[e.key].glyph) || '●';
            const rm = this.isGM ? ` data-act="fx-remove" data-id="${escHtml(c.id)}" data-key="${escHtml(e.key)}"` : '';
            return `<span class="badge-effect${this.isGM ? ' rm' : ''}" title="${escHtml(e.label)}${this.isGM ? ' (click to remove)' : ''}"${rm}>${glyph}</span>`;
        }).join('');
        const held = c.concentration && typeof c.concentration === 'object' && c.concentration.name ? c.concentration : null;
        const concBadge = held
            ? (mine
                ? `<button class="badge-conc rm" data-act="conc-drop" data-id="${escHtml(c.id)}" title="Concentrating on ${escHtml(held.name)} — click to let it go">◎ ${escHtml(held.name)}</button>`
                : `<span class="badge-conc" title="Concentrating on ${escHtml(held.name)}">◎ ${escHtml(held.name)}</span>`)
            : '';
        const ed = (field, val, title) => this.isGM
            ? `<span class="ce" data-act="edit" data-id="${escHtml(c.id)}" data-field="${field}" title="${title} (click to edit)">${escHtml(val)}</span>`
            : `<span title="${title}">${escHtml(val)}</span>`;

        let buttons = '';
        if (c.initiative == null && mine) {
            buttons += `<button class="btn-combat roll" data-act="roll-init" data-id="${escHtml(c.id)}">🎲 Init</button>`;
        }
        if (active && mine) {
            buttons += (Array.isArray(c.attacks) ? c.attacks : []).map((a, i) => attackAvailable(c, a)
                ? `<button class="btn-combat atk" data-act="attack" data-id="${escHtml(c.id)}" data-atk="${i}" title="${combatModifier(a?.attack)} to hit · ${escHtml(combatAttackDamageLabel(a))}">⚔ ${escHtml(a?.name)}</button>`
                : '').join('');
            const quickSpells = !c.bonusUsed && (Array.isArray(c.spells) ? c.spells : []).some(spell => spell?.time === 'bonus');
            if (c.actionUsed && quickSpells) {
                buttons += `<button class="btn-combat" data-act="cast-menu" data-id="${escHtml(c.id)}">✨ Cast <span class="tag">bonus</span></button>`
                    + `<span data-cast-menu="${escHtml(c.id)}" hidden>`
                    + c.spells.map((spell, i) => spell?.time === 'bonus' ? castButtonHTML(c, spell, i) : '').join('')
                    + `</span>`;
            }
            if (!c.actionUsed) {
                if (Array.isArray(c.spells) && c.spells.length) {
                    buttons += `<button class="btn-combat" data-act="cast-menu" data-id="${escHtml(c.id)}">✨ Cast</button>`
                        + `<span data-cast-menu="${escHtml(c.id)}" hidden>`
                        + c.spells.map((spell, i) => castButtonHTML(c, spell, i)).join('')
                        + `</span>`;
                }
                buttons += `<button class="btn-combat" data-act="dash" data-id="${escHtml(c.id)}">💨 Dash</button>`
                    + `<button class="btn-combat" data-act="dodge" data-id="${escHtml(c.id)}">🛡 Dodge</button>`
                    + `<button class="btn-combat" data-act="disengage" data-id="${escHtml(c.id)}">↪ Disengage</button>`;
            } else {
                const left = combatInteger(c.attacksLeft, { fallback: 0, min: 0, max: 4 })
                    + combatInteger(c.bonusAttacks?.count, { fallback: 0, min: 0, max: 4 });
                buttons += `<span class="tag">${left > 0 ? `${left} attack${left > 1 ? 's' : ''} left` : 'action used'}</span>`;
            }
            if (Array.isArray(c.abilities) && c.abilities.length) {
                buttons += `<button class="btn-combat" data-act="ability-menu" data-id="${escHtml(c.id)}">✦ Abilities${c.bonusUsed ? '' : ' <span class="tag">bonus ready</span>'}</button>`
                    + `<span data-ability-menu="${escHtml(c.id)}"${this.abilityMenuOpen === c.id ? '' : ' hidden'}>${combatAbilityButtonsHTML(c)}</span>`;
            }
            buttons += combatOptionsHTML(c);
            buttons += `<button class="btn-combat end" data-act="end-turn">■ End Turn</button>`;
        }

        let gmTools = '';
        if (this.isGM) {
            if (s.started) {
                gmTools += `<button class="btn-mini" data-act="set-turn" data-id="${escHtml(c.id)}" title="Jump turn here">▶</button>`
                    + `<button class="btn-mini" data-act="move-up" data-id="${escHtml(c.id)}" title="Move up">▲</button>`
                    + `<button class="btn-mini" data-act="move-down" data-id="${escHtml(c.id)}" title="Move down">▼</button>`;
            }
            gmTools += `<button class="btn-mini" data-act="remove" data-id="${escHtml(c.id)}" title="Remove from combat">✕</button>`
                + `<select class="fx-add" data-act="fx-add" data-id="${escHtml(c.id)}" title="Add condition">`
                + `<option value="">+fx</option>`
                + GM_CONDITIONS.map(k => `<option value="${k}">${EFFECTS[k].label}</option>`).join('')
                + `</select>`;
        }

        const initVal = c.initiative == null ? '—' : String(c.initiative);
        return `<div class="combat-row${active ? ' active' : ''}${mine ? ' mine' : ''}${c.statsPending ? ' pending' : ''}" data-row="${escHtml(c.id)}"${active ? ' aria-current="true"' : ''}>
            <div class="cr-main">
                <span class="cr-marker">${active ? '▶' : (s.started ? (idx + 1) : '')}</span>
                <button class="cr-name cr-focus" data-act="focus" data-id="${escHtml(c.id)}" style="border-left-color:${combatCssColor(c.color)}" title="Focus ${escHtml(displayName)} on the map">${escHtml(displayName)}${c.statsPending ? ' <span class="tag">…stats</span>' : ''}</button>
                <span class="cr-init" title="Initiative">🎲 ${this.isGM ? `<span class="ce" data-act="edit" data-id="${escHtml(c.id)}" data-field="initiative">${escHtml(initVal)}</span>` : escHtml(initVal)}</span>
                <span class="cr-stat" title="Armor Class">AC ${ed('ac', c.ac, 'Armor Class')}</span>
                <span class="cr-stat" title="Hit Points">HP ${ed('hp', hp, 'Hit Points (cur or cur/max)')}</span>
                <span class="cr-stat" title="Speed">${ed('speed', c.speedFeet, 'Speed (feet)')} ft</span>
                ${active ? `<span class="cr-move" title="Movement left this turn">${remainingFeet(c)} ft left</span>` : ''}
                ${badges}${concBadge}
                <span class="cr-progress" aria-hidden="true">
                    <span class="cr-progress-track" title="HP ${hp}"><span style="--progress:${hpPct}%"></span></span>
                    <span class="cr-progress-track move" title="${remainingFeet(c)} feet of movement left"><span style="--progress:${movePct}%"></span></span>
                </span>
            </div>
            ${buttons || gmTools ? `<div class="cr-actions">${buttons}${gmTools}</div>` : ''}
        </div>`;
    }

    render() {
        const s = this.state;
        if (!s) return;
        const order = this.displayOrder();
        const round = combatInteger(s.round, { fallback: 1, min: 0, max: 1000000 });
        const title = s.started ? `Combat — Round ${round}` : 'Combat — roll initiative!';
        let gmHeader = '';
        if (this.isGM) {
            gmHeader = (s.started
                ? `<button class="btn-combat" data-act="gm-next">Next Turn ⏭</button>`
                : `<button class="btn-combat" data-act="gm-begin" title="Auto-rolls missing initiative">Begin ▶</button>`)
                + `<button class="btn-combat danger" data-act="gm-end">End Combat</button>`;
        }
        const logs = Array.isArray(s.log) ? s.log : [];
        const combatants = s.combatants && typeof s.combatants === 'object' && !Array.isArray(s.combatants) ? s.combatants : {};
        const logToggle = `<button class="btn-combat" data-act="toggle-log" aria-pressed="${this.logOpen}">${this.logOpen ? 'Hide log' : `Log (${logs.length})`}</button>`;
        const rows = order.map((id, i) => this.rowHTML(combatants[id], i)).join('')
            || '<p class="muted">No combatants.</p>';
        let gmAdd = '';
        if (this.isGM) {
            const candidates = this.getMapObjects().filter(o =>
                (o.type === 'token' || o.type === 'character') && !combatants[o.id]);
            if (candidates.length) {
                gmAdd = `<select class="fx-add" data-act="gm-add"><option value="">+ add to combat…</option>`
                    + candidates.map(o => `<option value="${escHtml(o.id)}">${escHtml(o.name || o.type)}</option>`).join('')
                    + `</select>`;
            }
        }
        const log = logs.map(l => this.logLineHTML(l)).join('');
        this.container.innerHTML = `
            <div class="ct-header"><span class="ct-title">⚔ ${escHtml(title)}</span><span class="ct-btns">${logToggle}${gmHeader}</span></div>
            <div class="combat-flash"></div>
            ${this.pendingHTML()}${this.zonesHTML()}
            <div class="ct-rows">${rows}</div>
            ${gmAdd ? `<div class="ct-footer">${gmAdd}</div>` : ''}
            <div class="combat-log${this.logOpen ? '' : ' hidden'}">${log}</div>`;
        const logEl = this.container.querySelector('.combat-log');
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }

    // Areas that linger: what each does, and a way to end it for whoever may.
    zonesHTML() {
        const s = this.state;
        const zones = Array.isArray(s?.zones) ? s.zones : [];
        if (!zones.length) return '';
        const combatants = s?.combatants && typeof s.combatants === 'object' ? s.combatants : {};
        const rows = zones.map(zone => {
            if (!zone || typeof zone !== 'object') return '';
            const source = combatants[zone.sourceId];
            const mine = this.isGM || (source && this.canControl(source));
            const does = [zone.damage ? `${escHtml(zone.damage)} ${escHtml(zone.damageType || '')}`.trim() : '',
                zone.effect && EFFECTS[zone.effect] ? escHtml(EFFECTS[zone.effect].label.toLowerCase()) : ''].filter(Boolean).join(', ');
            const shape = describeShape({ kind: zone.aim?.kind, sizeFt: (Number(zone.aim?.size) || 0) * 5 });
            return `<span class="ct-zone" title="${escHtml(String(zone.saveAbility || '').toUpperCase())} save, DC ${escHtml(zone.dc)} — ${zone.on === 'start' ? 'starting a turn in it' : zone.on === 'enter' ? 'walking into it' : 'starting a turn in it or walking in'}">▦ <b>${escHtml(zone.name)}</b> <span class="muted">${escHtml(zone.sourceName)}${shape ? ` · ${escHtml(shape)}` : ''}${does ? ` · ${does}` : ''}</span>${mine ? `<button class="ct-zone-end" data-act="zone-end" data-zone="${escHtml(zone.id)}" title="End ${escHtml(zone.name)}">✕</button>` : ''}</span>`;
        }).join('');
        return `<div class="ct-zones"><span class="ct-pending-title">Areas</span>${rows}</div>`;
    }

    // Saving throws waiting to be rolled: a button for each one this user may
    // roll (their own characters; the GM: anyone), the rest named as waiting.
    pendingHTML() {
        const s = this.state;
        const list = Array.isArray(s?.pending) ? s.pending : [];
        const combatants = s?.combatants && typeof s.combatants === 'object' ? s.combatants : {};
        let mine = 0;
        const rows = list.map(pending => {
            if (!pending || typeof pending !== 'object' || !pending.targets) return '';
            const buttons = [], waiting = [];
            for (const [id, state] of Object.entries(pending.targets)) {
                const c = combatants[id];
                if (!c || !state || state.done) continue;
                if (this.canControl(c)) {
                    mine++;
                    buttons.push(`<button class="btn-combat roll" data-act="save" data-pending="${escHtml(pending.id)}" data-id="${escHtml(id)}">🎲 ${escHtml(this.displayName(c))}</button>`);
                } else waiting.push(escHtml(this.displayName(c)));
            }
            if (!buttons.length && !waiting.length) return '';
            if (pending.conc) {
                return `<div class="ct-pending-row"><span class="ct-pending-what"><b>Concentration</b> on ${escHtml(pending.name)} — CON save, DC ${escHtml(pending.dc)}</span>${buttons.join('')}${waiting.length ? `<span class="tag">waiting: ${waiting.join(', ')}</span>` : ''}</div>`;
            }
            const ability = escHtml(String(pending.saveAbility || '').toUpperCase());
const damage = (pending.damage ? ` · ${escHtml(pending.damage.total)} ${escHtml(pending.damageType || 'damage')}${pending.saveSuccess === 'half' ? ', half on a save' : ''}` : '')
                + (pending.effect && EFFECTS[pending.effect] ? ` · or ${escHtml(EFFECTS[pending.effect].label.toLowerCase())}` : '');
            return `<div class="ct-pending-row"><span class="ct-pending-what"><b>${escHtml(pending.name)}</b> — ${ability} save, DC ${escHtml(pending.dc)}${damage}</span>${buttons.join('')}${waiting.length ? `<span class="tag">waiting: ${waiting.join(', ')}</span>` : ''}</div>`;
        }).join('');
        if (!rows) return '';
        const all = mine > 1 ? `<button class="btn-combat" data-act="save-all">🎲 Roll all (${mine})</button>` : '';
        return `<div class="ct-pending${mine ? ' mine' : ''}"><span class="ct-pending-title">Saving throws</span>${rows}${all}</div>`;
    }

    // How many pending saves this user is expected to roll.
    owedSaves() {
        const s = this.state;
        let count = 0;
        for (const pending of (Array.isArray(s?.pending) ? s.pending : [])) {
            for (const [id, state] of Object.entries((pending && pending.targets) || {})) {
                const c = s.combatants && s.combatants[id];
                if (c && state && !state.done && this.canControl(c)) count++;
            }
        }
        return count;
    }

    onClick(e) {
        if (toggleAttackOption(e.target)) { this.render(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.tagName === 'SELECT') return;
        const act = btn.dataset.act, id = btn.dataset.id;
        const emit = (ev, payload) => this.socket && this.socket.emit(ev, payload);
        switch (act) {
            case 'roll-init': emit('combat-roll-initiative', { combatantId: id }); break;
            case 'end-turn': emit('combat-end-turn', {}); break;
            case 'save': emit('combat-save', { pendingId: btn.dataset.pending, combatantId: id }); break;
            case 'save-all': emit('combat-save', {}); break;
            case 'conc-drop': emit('combat-concentration', { combatantId: id }); break;
            case 'zone-end': emit('combat-zone', { id: btn.dataset.zone }); break;
            case 'dash': case 'dodge': case 'disengage':
                emit('combat-action', { combatantId: id, kind: act }); break;
            case 'attack': {
                const c = this.state && this.state.combatants[id];
                const i = Number(btn.dataset.atk);
                if (c && c.attacks[i]) this.onPickTarget(id, i, c.attacks[i], 'attack');
                break;
            }
            case 'cast-menu': {
                const row = btn.closest('[data-row]');
                const menu = row && row.querySelector('[data-cast-menu]');
                if (menu) menu.hidden = !menu.hidden;
                break;
            }
            case 'cast': {
                const c = this.state && this.state.combatants[id];
                const i = Number(btn.dataset.spell);
                if (c && c.spells && c.spells[i] && !btn.disabled) {
                    const menu = btn.closest('[data-cast-menu]');
                    if (menu) menu.hidden = true;
                    this.onPickTarget(id, i, c.spells[i], 'cast');
                }
                break;
            }
            case 'ability-menu':
                this.abilityMenuOpen = this.abilityMenuOpen === id ? null : id;
                this.render();
                break;
            case 'ability': {
                const c = this.state && this.state.combatants[id];
                const i = Number(btn.dataset.ability);
                if (c && c.abilities && c.abilities[i] && !btn.disabled) this.onPickTarget(id, i, c.abilities[i], 'ability');
                break;
            }
            case 'toggle-log':
                this.logOpen = !this.logOpen;
                this.render();
                break;
            case 'focus': this.onFocusCombatant(id); break;
            case 'set-turn': emit('combat-set-turn', { combatantId: id }); break;
            case 'remove': emit('combat-remove-combatant', { combatantId: id }); break;
            case 'move-up': case 'move-down': {
                const order = [...this.state.order];
                const idx = order.indexOf(id);
                const to = act === 'move-up' ? idx - 1 : idx + 1;
                if (idx < 0 || to < 0 || to >= order.length) break;
                [order[idx], order[to]] = [order[to], order[idx]];
                emit('combat-set-order', { order });
                break;
            }
            case 'fx-remove': emit('combat-effect', { combatantId: id, key: btn.dataset.key, add: false }); break;
            case 'gm-begin': emit('combat-begin', {}); break;
            case 'gm-next': emit('combat-end-turn', {}); break;
            case 'gm-end': emit('combat-end', {}); break;
            case 'edit': this.beginEdit(btn); break;
        }
    }

    onChange(e) {
        const sel = e.target.closest('select[data-act]');
        if (!sel || !sel.value) return;
        if (sel.dataset.act === 'fx-add') {
            this.socket.emit('combat-effect', { combatantId: sel.dataset.id, key: sel.value, add: true });
        } else if (sel.dataset.act === 'gm-add') {
            this.socket.emit('combat-add-combatant', { objectId: sel.value });
        }
        sel.value = '';
    }

    // GM inline edit: swap the value span for an input; Enter/blur commits.
    beginEdit(span) {
        if (!this.isGM || span.querySelector('input')) return;
        const id = span.dataset.id, field = span.dataset.field;
        const old = span.textContent.trim();
        span.innerHTML = `<input class="ce-input" value="${escHtml(old === '—' ? '' : old)}">`;
        const input = span.querySelector('input');
        input.focus(); input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            const raw = input.value.trim();
            span.textContent = old;
            if (!raw || raw === old) return;
            const patch = {};
            if (field === 'hp') {
                // "7" sets current HP; "7/12" sets current and max.
                const m = /^(\d+)\s*(?:\/\s*(\d+))?$/.exec(raw);
                if (!m) return;
                patch.hpCurrent = Number(m[1]);
                if (m[2]) patch.maxHP = Number(m[2]);
            } else {
                const v = Number(raw);
                if (!isFinite(v)) return;
                if (field === 'ac') patch.ac = v;
                else if (field === 'speed') patch.speedFeet = v;
                else if (field === 'initiative') patch.initiative = v;
            }
            this.socket.emit('combat-update-combatant', { combatantId: id, patch });
        };
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') commit();
            if (ev.key === 'Escape') { done = true; span.textContent = old; }
            ev.stopPropagation();
        });
        input.addEventListener('blur', commit);
    }
}

// --- three.js overlays --------------------------------------------------------
// All of these are world-coordinate meshes: pages must add them to worldGroup
// (never the scene) so they follow the floating origin.

// Owns the turn ring, movement-range ring and effect badges for one screen.
// sync(combat) rebuilds them from a state broadcast; tick() runs every frame so
// the overlays follow their tokens (drag previews included).
export class CombatOverlays {
    constructor({ worldGroup, findMesh, feetToWorld }) {
        this.worldGroup = worldGroup;
        this.findMesh = findMesh;          // combatant id -> mesh (or undefined)
        this.feetToWorld = feetToWorld;    // feet -> world units
        this.combat = null;
        this.turnRing = null;
        this.rangeRing = null;
        this.badges = new Map();           // combatant id -> sprite
    }

    clear() {
        if (this.turnRing) {
            this.worldGroup.remove(this.turnRing);
            let material = null;
            this.turnRing.traverse(part => { if (part.geometry) part.geometry.dispose(); material = part.material || material; });
            if (material) material.dispose();          // one shared material across the ring's parts
            this.turnRing = null;
        }
        if (this.rangeRing) { this.worldGroup.remove(this.rangeRing); this.rangeRing.geometry.dispose(); this.rangeRing.material.dispose(); this.rangeRing = null; }
        for (const spr of this.badges.values()) {
            this.worldGroup.remove(spr);
            if (spr.material.map) spr.material.map.dispose();
            spr.material.dispose();
        }
        this.badges.clear();
    }

    sync(combat) {
        this.combat = combat;
        this.clear();
        const combatants = combat?.combatants && typeof combat.combatants === 'object' && !Array.isArray(combat.combatants)
            ? combat.combatants : null;
        if (!combat || !combat.started || !combatants) return;
        const active = combatants[combat.activeId];
        if (active && this.findMesh(active.id)) {
            this.turnRing = createTurnRing();
            this.worldGroup.add(this.turnRing);
            const left = remainingFeet(active);
            if (left > 0) {
                this.rangeRing = createRangeRing(this.feetToWorld(left));
                this.worldGroup.add(this.rangeRing);
            }
        }
        for (const c of Object.values(combatants)) {
            if (!c || !Array.isArray(c.effects) || !c.effects.length) continue;
            const spr = createEffectBadge(c.effects);
            if (spr && this.findMesh(c.id)) { this.badges.set(c.id, spr); this.worldGroup.add(spr); }
        }
        this.tick();
    }

    tick() {
        const combat = this.combat;
        if (combat && combat.started) {
            const mesh = this.findMesh(combat.activeId);
            if (mesh) {
                if (this.turnRing) {
                    this.turnRing.position.set(mesh.position.x, mesh.position.y + 0.04, mesh.position.z);
                    this.turnRing.rotation.z += 0.02;
                }
                if (this.rangeRing) this.rangeRing.position.set(mesh.position.x, mesh.position.y + 0.04, mesh.position.z);
            }
        }
        for (const [id, spr] of this.badges) {
            const mesh = this.findMesh(id);
            if (mesh) spr.position.set(mesh.position.x, mesh.position.y + 1.6, mesh.position.z);
        }
    }
}

export function createTurnRing() {
    // A turning brass compass: a fine inner band, a broken outer band and four
    // points, so the slow spin (tick) is visible and it reads as "whose turn".
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd772, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false });
    const ring = new THREE.Group();
    const add = (geo) => { const m = new THREE.Mesh(geo, mat); m.renderOrder = 999; m.raycast = () => {}; ring.add(m); };
    add(new THREE.RingGeometry(0.47, 0.5, 48));
    for (let i = 0; i < 4; i++) {
        add(new THREE.RingGeometry(0.56, 0.62, 12, 1, i * Math.PI / 2 + 0.2, Math.PI / 2 - 0.4));
        const tip = new THREE.BufferGeometry();
        const a = i * Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
        tip.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            c * 0.56 - s * 0.06, s * 0.56 + c * 0.06, 0,
            c * 0.56 + s * 0.06, s * 0.56 - c * 0.06, 0,
            c * 0.74, s * 0.74, 0
        ]), 3));
        add(tip);
    }
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 999;
    return ring;
}

// Thin circle line showing the movement left this turn (radius in world units).
export function createRangeRing(radiusWorld) {
    const segs = 72, pts = [];
    for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radiusWorld, 0, Math.sin(a) * radiusWorld));
    }
    const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({
            color: 0xf5e6c2, transparent: true, opacity: 0.8, depthTest: false,
            dashSize: 0.34, gapSize: 0.2
        })
    );
    line.computeLineDistances();
    line.renderOrder = 998;
    return line;
}

// Floating sprite of up to 3 effect glyphs, hovered above a token by the page.
export function createEffectBadge(effects) {
    const glyphs = (Array.isArray(effects) ? effects : []).slice(0, 3)
        .filter(e => e && typeof e === 'object')
        .map(e => (EFFECTS[e.key] && EFFECTS[e.key].glyph) || '●');
    if (!glyphs.length) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 192; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(22, 17, 12, 0.86)';       // same ink-and-brass plaque as the nameplates
    const w = 24 + glyphs.length * 46;
    const x0 = (canvas.width - w) / 2;
    ctx.beginPath();
    ctx.roundRect(x0, 6, w, 52, 14);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(201, 164, 92, 0.85)';
    ctx.stroke();
    ctx.font = '34px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    glyphs.forEach((g, i) => ctx.fillText(g, x0 + 35 + i * 46, 34));
    const tex = new THREE.CanvasTexture(canvas);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.scale.set(1.5, 0.5, 1);
    spr.renderOrder = 1000;
    return spr;
}
