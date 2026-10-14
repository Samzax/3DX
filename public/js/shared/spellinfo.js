// spellinfo.js — what a spell says and what casting it rolls (pure: no DOM).
// The creator's spell picker and the player's Spells panel show the same card
// (`spellDetailHTML`); the Spells panel turns a spell into a table roll with
// `spellCastRequest` (shared/rolllog.js → the server's `roll`).

import { escHtml } from './campaigns.js';

const ORDINALS = ['Cantrip', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

export function spellLevelLabel(level) {
    const n = Math.max(0, Math.min(9, Number(level) || 0));
    return n === 0 ? 'Cantrip' : `${ORDINALS[n]} level`;
}

// "3rd-level evocation · ritual"
export function spellHeadline(spell) {
    const school = (spell.school && (spell.school.name || spell.school.index)) || '';
    const base = spell.level > 0 ? `${ORDINALS[spell.level]}-level ${school.toLowerCase()}` : `${school} cantrip`;
    return base.trim() + (spell.ritual ? ' · ritual' : '');
}

function components(spell) {
    const parts = (spell.components || []).join(', ');
    return spell.material ? `${parts} (${String(spell.material).replace(/\.$/, '')})` : parts;
}

// The dice a spell deals or heals when cast with a slot of `slotLevel` by a
// caster of `charLevel`: → { expr, type, heal } or null (no dice in the data).
export function spellDice(spell, { slotLevel = spell.level, charLevel = 1, abilityMod = 0 } = {}) {
    const pick = (table, at) => {
        const keys = Object.keys(table || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        const key = keys.filter(k => k <= at).pop() ?? keys[0];
        return key == null ? null : String(table[key]);
    };
    const clean = (dice) => dice && dice.replace(/MOD/gi, String(Math.abs(abilityMod))).replace(/\+\s*-/g, '-')
        .replace(/\s+/g, '').replace(/\+0$/, '');
    if (spell.damage) {
        const dice = spell.level === 0
            ? pick(spell.damage.damage_at_character_level, charLevel)
            : pick(spell.damage.damage_at_slot_level, slotLevel);
        const type = ((spell.damage.damage_type && spell.damage.damage_type.name) || '').toLowerCase();
        if (dice) return { expr: clean(dice), type, heal: false };
    }
    if (spell.heal_at_slot_level) {
        const dice = pick(spell.heal_at_slot_level, slotLevel);
        if (dice) return { expr: clean(abilityMod < 0 ? dice.replace('+', '-') : dice), type: 'healing', heal: true };
    }
    return null;
}

// One line of the numbers that matter at the table: "8d6 fire · DEX save, half on a success".
export function spellMechanics(spell, opts = {}) {
    const bits = [];
    const dice = spellDice(spell, opts);
    if (dice) bits.push(`${dice.expr} ${dice.type}`.trim());
    if (spell.attack_type) bits.push(`${spell.attack_type} spell attack`);
    if (spell.dc && spell.dc.dc_type) {
        const ability = String(spell.dc.dc_type.name || spell.dc.dc_type.index).toUpperCase();
        bits.push(`${ability} save${dice ? (spell.dc.dc_success === 'half' ? ', half on a success' : ', none on a success') : ''}`);
    }
    if (spell.area_of_effect) bits.push(`${spell.area_of_effect.size} ft ${spell.area_of_effect.type}`);
    return bits.join(' · ');
}

// The full card: headline, casting facts, rules text, "at higher levels".
export function spellDetailHTML(spell, opts = {}) {
    const fact = (label, value) => value ? `<div><span>${label}</span><b>${escHtml(value)}</b></div>` : '';
    const paragraphs = (list) => (Array.isArray(list) ? list : [list]).filter(Boolean)
        .map(text => `<p>${escHtml(text)}</p>`).join('');
    const mechanics = spellMechanics(spell, opts);
    return `<div class="spell-detail">
        <div class="spell-detail-head">${escHtml(spellHeadline(spell))}</div>
        <div class="spell-facts">
            ${fact('Casting time', spell.casting_time)}
            ${fact('Range', spell.range)}
            ${fact('Components', components(spell))}
            ${fact('Duration', (spell.concentration ? 'Concentration, ' : '') + (spell.duration || ''))}
        </div>
        ${mechanics ? `<div class="spell-mechanics">${escHtml(mechanics)}</div>` : ''}
        <div class="spell-text">${paragraphs(spell.desc) || '<p>No description.</p>'}</div>
        ${spell.higher_level && spell.higher_level.length ? `<div class="spell-text spell-higher"><b>At higher levels.</b> ${paragraphs(spell.higher_level)}</div>` : ''}
    </div>`;
}

// What casting rolls at the table. caster: { atk, dc, abilityMod, charLevel };
// → a rolllog request { label, d20?, dice?, note }.
export function spellCastRequest(spell, caster = {}, slotLevel = spell.level) {
    const dice = spellDice(spell, { slotLevel, charLevel: caster.charLevel || 1, abilityMod: caster.abilityMod || 0 });
    const upcast = spell.level > 0 && slotLevel > spell.level ? ` with a ${ORDINALS[slotLevel]}-level slot` : '';
    const request = { label: `casts ${spell.name}${upcast}` };
    if (spell.attack_type) request.d20 = { bonus: caster.atk || 0 };
    if (dice) request.dice = [{ expr: dice.expr, type: dice.type }];
    const notes = [];
    if (spell.attack_type) notes.push(`${spell.attack_type} spell attack`);
    if (spell.dc && spell.dc.dc_type) {
        const ability = String(spell.dc.dc_type.name || spell.dc.dc_type.index).toUpperCase();
        notes.push(`DC ${caster.dc || '?'} ${ability} save${dice ? (spell.dc.dc_success === 'half' ? ' (half on a success)' : ' (none on a success)') : ''}`);
    }
    notes.push(`range ${spell.range || '—'}`, (spell.concentration ? 'concentration, ' : '') + String(spell.duration || '').toLowerCase());
    request.note = notes.filter(Boolean).join(' · ');
    return request;
}
